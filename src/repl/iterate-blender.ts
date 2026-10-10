/**
 * /iterate blender in the REPL (round R4, helper H26): the Blender variant of the connected workflow, one flow with its
 * own id (f + 8 hex), run beside the tray flows (src/repl/iterate.ts parses the line and hands it here):
 *
 *   1. the script is checked before anything starts: a .py in the project, reached through no link, outside .git,
 *      node_modules, .timmy and dist (the agent's before/after comparison does not look there), at most 256 KB;
 *      Blender and the readback worker must be there too. Its bytes are read and kept in the flow's folder;
 *   2. a local code agent runs through /agent's own start (Qwen Code on a loopback endpoint, or, since R4 H33, Codex's
 *      local route under the same rule; nothing else), told to change only that script;
 *   3. after it: any other file changed, the script deleted, or changed after the agent ended, no change, or a script
 *      that no longer parses as Python (an AST parse by this machine's python3 when there is one; otherwise not
 *      checked, and said so) stops the flow before Blender runs. Nothing is reverted;
 *   4. Blender runs the script as a judged native job (src/native blenderJob: the read-only copy kept at submission,
 *      judged by the run's own result file), this REPL's job as /blender's are; the flow waits for the judgement;
 *   5. a second, separate Blender process opens the one .blend the run's result names
 *      (`blender -b <file> --factory-startup --python workers/readback/blend_readback.py`) and prints what it holds;
 *      Timmy hashes the file itself before and after; what was read is compared with what the run's result reported
 *      (objects, materials, camera, and the resolution and frames when reported; R4, H37: each object's world-space
 *      bounding box, within 1e-6 Blender units): matches, differs or failed;
 *   6. the flow record (results/flows/<flow-id>.json) and a `flow` receipt binding its sha256 and the child receipts
 *      (the agent's, the Blender run's native receipt, the second pass's). Every raw failure stays where it was
 *      written, and the record names it. R4 (H37): the record's `dimensions` sets the sizes Blender's run reported
 *      against those of a judged-ok Blender run of the same script from before the flow (looked for when it starts),
 *      and the end lines show the objects whose size changed and a count of the rest.
 *
 * /stop <flow-id> stops the step that runs: the agent's job, the Blender job, the second pass's job (and the syntax
 * check's python3, through the flow's abort). /stop all and the REPL's end stop every flow. The second pass is the
 * same application reading its own file in a separate process: a second pass, not an independent implementation.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, writeSync } from 'node:fs';
import path from 'node:path';
import type { JobRecord } from '../jobs/index.js';
import { AGENTS, AGENTS_DIR, agentBin, comparedOf, forJudging, notComparedText, planAgent, type AgentName, type AgentRunRecord } from '../code-agents/index.js';
import { codexLocalPreflight } from '../code-agents/codex-local.js';
import { blenderJob, judgeNativeJob, locateNative, NATIVE_APPS, NativeNotFound, readNativeResult, sha256File, type NativeJobSpec } from '../native/index.js';
import { projectId, resolveInside } from '../project/index.js';
import { DOCTRINE_15, FLOW_SCHEMA, flowRecordPath, flowWorkDir, newFlowId, writeProjectJson } from '../flows/iterate.js';
import {
  BLEND_READBACK_MAX_OUTPUT, BLEND_READBACK_SCOPE, BLEND_READBACK_SCRIPT, BLEND_READBACK_TIMEOUT_MS, blenderIterateTask, changeText, compareBlendReadback,
  differencesText, DIMENSIONS_SCOPE, dimensionsSummary, dimensionsText, findBeforeRun, judgeScriptChanges, parseBlendReadback, parseSyntaxOutput, reportedByResult,
  SCRIPT_MAX_BYTES, scriptChange, SYNTAX_CHECK_CODE, SYNTAX_TIMEOUT_MS, syntaxText, unseenFolder, type BlendReadback, type BlendReadbackFailure, type BlendVerdict,
  type BlenderFlowRecord, type BlenderFlowStep, type DimensionsBefore, type SyntaxCheck,
} from '../flows/iterate-blender.js';
import type { IterateDeps } from './iterate.js';
import type { FlowLock } from './flow-lock.js';
import type { Segment } from '../term/theme.js';

type Line = Segment[];

export const BLENDER_USAGE = '/iterate blender <script.py> "<instruction>" [--agent qwen|codex] [--model <local model>]';

/** `/iterate blender <script.py> "<instruction>"`, parsed (src/repl/iterate.ts parseIterateLine). */
export interface BlenderIterateRequest { recipe: 'blender'; script: string; instruction: string; agent: AgentName; model?: string }

interface BlenderRun {
  id: string;
  root: string;
  project: string;
  record: BlenderFlowRecord;
  abort: AbortController;
  step: BlenderFlowStep | 'done';
  /** the script's text as read before the agent ran (the change is summarised against it) */
  beforeText: string;
  agentJob?: string;
  agentRecord?: AgentRunRecord;
  spec?: NativeJobSpec;
  blenderJob?: string;
  readbackJob?: string;
  done?: Promise<BlenderFlowRecord>;
  receipt?: string;
  recordFile?: string;
  /** R4 (H37): a judged-ok Blender run of the script as it was, from before the flow started (its object sizes), or why none */
  before?: { ok: true; before: DimensionsBefore } | { ok: false; why: string };
}

type Started = { ok: true; flow: BlenderRun; lines: Line[] } | { ok: false; error: string; lines: Line[] };

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const short = (s: string | null | undefined): string => (s ? s.slice(0, 12) : '?');
const lineCount = (t: string): number => (t ? t.split('\n').length - (t.endsWith('\n') ? 1 : 0) : 0);
/** R4 (H46): its timer holds the event loop while awaited (unref'd, Node could exit under a typed command) and is cleared once `p` settles. */
const within = <T>(p: Promise<T>, ms: number): Promise<T | undefined> => {
  let t: NodeJS.Timeout | undefined;
  return Promise.race([p, new Promise<undefined>((resolve) => { t = setTimeout(() => resolve(undefined), ms); })]).finally(() => clearTimeout(t));
};
const IMAGE = /\.(png|jpe?g|exr|tiff?|webp|bmp)$/i;
const BLEND = /\.blend$/i;
const exitWords = (j: JobRecord): string => j.error ?? (j.signal ? `ended by ${j.signal}` : `exited ${j.exitCode ?? '?'}`);

export class BlenderFlows {
  private readonly running = new Map<string, BlenderRun>();

  /**
   * `busyElsewhere`: a flow of another kind running in a project (one flow at a time runs in a project, of any kind).
   * `lock` (R4 review, R4-5): the projects a start holds (src/repl/flow-lock.ts); IterateFlows takes it around every
   * start, and the start names its flow there before its first await.
   */
  constructor(private readonly d: IterateDeps, private readonly busyElsewhere: (root: string) => { id: string; step: string } | undefined, private readonly lock?: FlowLock) {}

  private get sep(): string { return ` ${this.d.glyphs.sep} `; }
  private say(text: string, role: Segment['role'] = 'secondary'): Line[] { return [[{ text: `  ${text}`, role }]]; }

  /** The Blender flows this REPL is running (their ids). */
  get active(): string[] { return [...this.running.keys()]; }
  has(id: string): boolean { return this.running.has(id); }
  /** The Blender flow running in this project, if one is (one being started holds the project's lock instead). */
  runningIn(root: string): { id: string; step: string } | undefined {
    const f = [...this.running.values()].find((x) => x.root === root);
    return f ? { id: f.id, step: f.step } : undefined;
  }

  /** /iterate's rows for the Blender flows running in this project. */
  runningRows(root: string): Line[] {
    return [...this.running.values()].filter((f) => f.root === root).map((f) => [{ text: `    ${this.d.glyphs.bullet} ` }, { text: f.id, role: 'strong' as const },
      { text: `  running: the ${f.step} step${this.sep}/stop ${f.id}${this.sep}blender ${f.record.script.path}: ${this.d.scrub(f.record.instruction, root).slice(0, 50)}`, role: 'secondary' as const }]);
  }

  /** /iterate's usage lines for the Blender flow, with whether Blender is found (found is not run). */
  usageLines(): Line[] {
    const { found, problem } = locateNative('blender', this.d.env());
    const how = found ? (found.how === 'env' ? 'set by TIMMY_BLENDER' : found.how === 'applications' ? 'in /Applications' : 'on PATH') : '';
    return [
      [{ text: '  Blender    ', role: 'secondary' }, { text: BLENDER_USAGE, role: 'strong' }],
      ...this.say('           the agent may change only that script; Blender runs it as a judged job; a second Blender process reads its .blend back'),
      found
        ? [{ text: '             ', role: 'secondary' }, { text: `Blender found (${how})`, role: 'strong' }, { text: `${this.sep}it runs when a flow does, not now`, role: 'secondary' }]
        : [{ text: '             ', role: 'secondary' }, { text: `Blender not found${problem ? ` (${problem})` : ''}`, role: 'estimate' }, { text: `${this.sep}${NATIVE_APPS.blender.setup}`, role: 'secondary' }],
    ];
  }

  async start(req: BlenderIterateRequest, at: { root: string; project: string }): Promise<Started> {
    const { root, project } = at;
    const scrub = (t: string): string => this.d.scrub(t, root);
    const refuse = (error: string, role: Segment['role'] = 'failure', more: Line[] = []): Started => ({ ok: false, error, lines: [...this.say(error, role), ...more] });
    const env: NodeJS.ProcessEnv = { ...this.d.env(), ...(req.model ? { TIMMY_AGENT_MODEL: req.model } : {}) };
    // The script first: a regular .py in the project, reached through no link, where the agent's comparison can see it.
    const at_ = resolveInside(root, req.script);
    if ('error' in at_) return refuse(`${scrub(at_.error)}. Nothing was started.`);
    const rel = at_.rel;
    if (!/\.py$/i.test(rel)) return refuse(`${rel} is not a Python file (.py): /iterate blender changes a Blender Python script. Nothing was started.`);
    const hidden = unseenFolder(rel);
    if (hidden) return refuse(`${rel} is inside ${hidden}/, which the agent's before/after comparison does not look into, so a change to it could not be seen: keep the script elsewhere in the project. Nothing was started.`);
    let realRoot: string;
    try { realRoot = realpathSync(root); } catch { return refuse('The project folder is gone. Nothing was started.'); }
    let st;
    try { st = lstatSync(at_.path); } catch { return refuse(`No script at ${rel}: /project new <name> --from blender-starter makes a project with one (scene.py). Nothing was started.`); }
    if (at_.path !== path.join(realRoot, ...rel.split('/')) || st.isSymbolicLink()) return refuse(`${rel} is reached through a symbolic link, and the agent's before/after comparison sees the link, not the file: name the file itself. Nothing was started.`);
    if (!st.isFile()) return refuse(`${rel} is not a regular file. Nothing was started.`);
    if (st.size > SCRIPT_MAX_BYTES) return refuse(`${rel} is ${st.size} bytes: /iterate blender gives the agent the whole script, and takes scripts up to ${SCRIPT_MAX_BYTES / 1024} KB. Nothing was started.`);
    // The route: local and free, or refused with the reason.
    const info = AGENTS[req.agent];
    const bin = agentBin(req.agent, env, this.d.onPath);
    if (!bin) return refuse(`${info.title} is not on PATH (${info.bin}); /tools says how to install it. Nothing was started.`, 'estimate');
    if (!env.TIMMY_AGENT_MODEL?.trim()) return refuse(`Name the local model: ${BLENDER_USAGE.replace('[--model <local model>]', '--model <a model your local endpoint serves, from ollama list>')}, or set TIMMY_AGENT_MODEL. Nothing was started.`);
    // R4 (H33): --agent codex is Codex's local route (codex exec --oss), under the same rule as /iterate tray's.
    const local = req.agent === 'codex' ? { local: true as const } : {};
    const route = planAgent(req.agent, req.instruction, { env, paid: false, run: 'a00000000', bin, ...local, root });
    if (!route.ok) {
      const why = route.error.replace(/\s*To run it anyway:.*$/, '');
      return route.refused === 'paid' ? refuse(`${why} /iterate runs only a local, free route, and has no --paid.`, 'estimate') : refuse(why);
    }
    // One flow at a time in a project: an agent's before/after comparison covers the whole project.
    const busy = this.runningIn(root) ?? this.busyElsewhere(root);
    if (busy) return refuse(`Flow ${busy.id} is still running in this project (its ${busy.step} step), and one flow at a time runs in a project (an agent's before/after comparison covers all of it): wait for it, or /stop ${busy.id}. Nothing was started.`, 'estimate');
    // Blender before the agent works: it runs after the agent, so it comes first.
    const located = locateNative('blender', env);
    if (!located.found) {
      return refuse(`Not started: ${NATIVE_APPS.blender.name} was not found on this machine${located.problem ? ` (${located.problem})` : ''}. /iterate blender runs Blender after the agent, so Blender comes first.`, 'estimate', this.say(`Setup: ${NATIVE_APPS.blender.setup}, then /iterate again.`));
    }
    if (!existsSync(BLEND_READBACK_SCRIPT)) return refuse('Not started: the readback worker (workers/readback/blend_readback.py) is missing from this Timmy.');
    if (!this.d.startNative) return refuse('Not started: this REPL cannot start a native job.');
    const id = newFlowId();
    // R4 review (R4-5): the project is held for this start (IterateFlows takes the lock around it, before this start's
    // first await, and gives it back when it ends); its flow is named there now, so a start refused meanwhile names it.
    this.lock?.name(root, id);
    // R4 (H33): Codex's local route needs its model already in the local Ollama; asked before anything is written.
    if (route.plan.oss) {
      const ready = await codexLocalPreflight(route.plan.oss);
      if (!ready.ok) return refuse(scrub(ready.error), 'estimate');
    }
    // The script's bytes now: the task quotes them, their sha256 is the "before" every later check compares with.
    let bytes: Buffer;
    try { bytes = readFileSync(at_.path); } catch (e) { return refuse(`${rel} could not be read: ${scrub(e instanceof Error ? e.message : String(e))}. Nothing was started.`); }
    const beforeText = bytes.toString('utf8');
    const task = blenderIterateTask({ instruction: req.instruction, scriptRel: rel, scriptText: beforeText });
    // The agent's start is awaited; the project stays held (its lock) until this start ends.
    // R4 review (R4-2): judged by the whole project, .timmy and dist included; the flow's own folder is Timmy's write.
    const s = await this.d.startAgent(req.agent, task, { paid: false, ...local, root, project, env, judge: { own: [flowWorkDir(id)] } });
    if (!s.ok) return refuse(`The agent did not start: ${scrub(s.error)}`, s.refused === 'paid' || s.refused === 'missing' ? 'estimate' : 'failure');
    const kept = keepBytes(root, `${flowWorkDir(id)}/script.before.py`, bytes);
    const record: BlenderFlowRecord = {
      flow: 1, schema: FLOW_SCHEMA, id, kind: 'iterate', target: 'blender', instruction: req.instruction, project, started_at: new Date().toISOString(), outcome: 'running',
      script: { path: rel, before: { sha256: sha(bytes), bytes: bytes.length, lines: lineCount(beforeText), ...(kept ? { kept } : {}) } },
      agent: {
        run: s.run, agent: s.plan.agent, version: s.version, route: s.plan.charge, where: s.plan.where, model: s.plan.model, job: s.job.id,
        result: `${AGENTS_DIR}/${s.run}/result.json`, progress: `${AGENTS_DIR}/${s.run}/progress.log`,
      },
      receipts: {}, child_receipts: [], doctrine: DOCTRINE_15,
    };
    const flow: BlenderRun = { id, root, project, record, abort: new AbortController(), step: 'agent', beforeText, agentJob: s.job.id, agentRecord: s.record };
    // R4 (H37): the object sizes from before, as a judged-ok Blender run of these same bytes reported them (read only)
    try { flow.before = findBeforeRun(root, { path: rel, sha256: record.script.before.sha256 }, record.started_at); } catch (e) {
      flow.before = { ok: false, why: `the runs from before could not be read (${scrub(e instanceof Error ? e.message : String(e))})` };
    }
    this.running.set(id, flow);
    this.saveState(flow);
    flow.done = this.run(flow).finally(() => { this.running.delete(id); });
    const g = this.d.glyphs;
    const how = located.found.how === 'env' ? 'set by TIMMY_BLENDER' : located.found.how === 'applications' ? 'in /Applications' : 'on PATH';
    return {
      ok: true, flow, lines: [
        [{ text: '  Flow       ', role: 'secondary' }, { text: id, role: 'strong' }, { text: `  iterate blender ${rel}: ${scrub(req.instruction)}`, role: 'secondary' }],
        [{ text: '  Script     ', role: 'secondary' }, { text: rel, role: 'strong' }, { text: `  ${record.script.before.lines} lines${this.sep}sha256 ${short(record.script.before.sha256)}${kept ? `${this.sep}kept as read: ${kept}` : ''}`, role: 'secondary' }],
        [{ text: '  Agent      ', role: 'secondary' }, { text: s.job.id, role: 'strong' }, { text: `  agent ${s.plan.agent} ${s.run}${this.sep}${s.info.title}${s.version ? ` ${s.version}` : ''}${s.plan.model ? `${this.sep}model ${s.plan.model} at ${s.plan.where}` : ''}${this.sep}${s.plan.charge}`, role: 'secondary' }],
        [{ text: '  Next       ', role: 'secondary' }, { text: `it may change only ${rel}; then Blender (found, ${how}) runs it as a judged job, and a second Blender process reads its .blend back`, role: 'secondary' }],
        [{ text: '  Follow     ', role: 'secondary' }, { text: `/jobs ${s.job.id}${this.sep}/stop ${id} stops the flow${this.sep}/iterate lists flows${this.sep}the record: ${flowRecordPath(id)} ${g.arrow} /board`, role: 'secondary' }],
      ],
    };
  }

  // ── the steps ────────────────────────────────────────────────────────────────

  private async run(f: BlenderRun): Promise<BlenderFlowRecord> {
    try {
      await this.agentStep(f);
      if (f.record.outcome === 'running') await this.checksStep(f);
      if (f.record.outcome === 'running') await this.blenderStep(f);
      if (f.record.outcome === 'running') await this.readbackStep(f);
      if (f.record.outcome === 'running') this.end(f, 'failed', 'record', 'the flow ended without a verdict');
    } catch (e) {
      this.end(f, this.stopped(f) ? 'cancelled' : 'failed', f.step === 'done' ? 'record' : f.step, `the flow could not go on: ${this.d.scrub(e instanceof Error ? e.message : String(e), f.root)}`);
    }
    return this.finish(f);
  }

  private end(f: BlenderRun, outcome: Exclude<BlenderFlowRecord['outcome'], 'running'>, step: BlenderFlowStep, why: string): void {
    if (f.record.outcome !== 'running') return;
    f.record.outcome = outcome;
    f.record.ended_in = step;
    f.record.why = why;
  }

  private stopped(f: BlenderRun): boolean { return f.abort.signal.aborted; }

  private note(f: BlenderRun, text: string, role: Segment['role'] = 'secondary'): void {
    this.d.notify([{ text: `  ${this.d.glyphs.bullet} ` }, { text: f.id, role: 'strong' }, { text: `  ${text}`, role }]);
  }

  private saveState(f: BlenderRun): void {
    writeProjectJson(f.root, `${flowWorkDir(f.id)}/state.json`, { ...f.record, step: f.step });
  }

  /** A job's raw output (stdout and stderr as it logged them), copied into the flow's folder; its place, sha256 and size. */
  private keepLog(f: BlenderRun, job: JobRecord, name: string): { rel: string; sha256: string; bytes: number } | undefined {
    const rel = `${flowWorkDir(f.id)}/${name}`;
    try {
      const at = resolveInside(f.root, rel);
      if ('error' in at) return undefined;
      mkdirSync(path.dirname(at.path), { recursive: true });
      copyFileSync(job.logPath, at.path);
      const b = readFileSync(at.path);
      return { rel, sha256: sha(b), bytes: b.length };
    } catch { return undefined; }
  }

  private async agentStep(f: BlenderRun): Promise<void> {
    const job = await this.d.jobs.done(f.agentJob!);
    // The agent's sealed result (sealAgent ran at the job's end): its outcome, what it changed, its cost and receipt.
    // R4 review (R4-2): what it changed as the check's own snapshot saw it (the whole project, .timmy and dist included).
    const rec = forJudging(f.agentRecord!);
    f.agentRecord = rec;
    const a = f.record.agent!;
    if (rec.judged) a.compared = comparedOf(rec.judged);
    a.outcome = rec.outcome ?? job.state;
    if (rec.why) a.why = this.d.scrub(rec.why, f.root);
    if (rec.transcript) a.transcript = `${AGENTS_DIR}/${rec.run}/${rec.transcript}`;
    if (rec.cost_usd !== undefined) { a.cost_usd = rec.cost_usd; a.cost_basis = rec.cost_basis; }
    const receipt = rec.receipt ?? job.receipt;
    if (receipt) { a.receipt = receipt; f.record.receipts.agent = receipt; }
    if (rec.files) {
      a.files_changed = [
        ...rec.files.added.map((c) => ({ path: c.path, how: 'added' as const, sha256_after: c.sha256 })),
        ...rec.files.changed.map((c) => ({ path: c.path, how: 'changed' as const, sha256_before: c.previous_sha256 ?? null, sha256_after: c.sha256 })),
        ...rec.files.deleted.map((c) => ({ path: c.path, how: 'deleted' as const, sha256_before: c.previous_sha256 ?? null })),
      ].slice(0, 200);
    }
    const kept = a.transcript ? `; its output is kept: ${a.transcript}` : '';
    if (this.stopped(f) || a.outcome === 'cancelled' || job.state === 'cancelled') return this.end(f, 'cancelled', 'agent', `stopped with /stop during the agent step; Blender did not run${kept}`);
    if (a.outcome !== 'completed') return this.end(f, 'failed', 'agent', `the agent run ended ${a.outcome}${a.why ? `: ${a.why}` : ''}; Blender did not run${kept}`);
    this.saveState(f);
  }

  private async checksStep(f: BlenderRun): Promise<void> {
    f.step = 'checks';
    const rel = f.record.script.path;
    const before = f.record.script.before;
    const a = f.record.agent!;
    const kept = a.transcript ? `; the agent's output is kept: ${a.transcript}` : '';
    const judged = judgeScriptChanges(f.agentRecord?.files, rel);
    if (!judged.ok) {
      if (judged.others.length) a.others = judged.others;
      return this.end(f, 'stopped', 'checks', `${judged.why}; Blender did not run, and nothing was reverted${kept}`);
    }
    // The agent's snapshot before it ran must have seen the bytes Timmy read (and gave it in its task).
    const seenBefore = judged.change?.previous_sha256;
    if (judged.params === 'changed' && seenBefore && seenBefore !== before.sha256) {
      return this.end(f, 'stopped', 'checks', `${rel} changed between Timmy's read and the agent's start (sha256 ${short(before.sha256)} read, ${short(seenBefore)} when the agent started); Blender did not run`);
    }
    // The file as it is now, read here (not the agent's word): it must be what the agent's own snapshot saw.
    let bytes: Buffer;
    try { bytes = readFileSync(path.join(f.root, rel)); } catch { return this.end(f, 'stopped', 'checks', `${rel} cannot be read after the agent's run; Blender did not run`); }
    const now = sha(bytes);
    const seen = judged.params === 'changed' ? judged.change?.sha256 ?? null : before.sha256;
    if (seen !== now) return this.end(f, 'stopped', 'checks', `${rel} changed after the agent's run ended (sha256 ${short(now)} now; the agent left ${seen ? short(seen) : 'an unhashed file'}); Blender did not run`);
    if (judged.params === 'unchanged') return this.end(f, 'stopped', 'checks', 'the agent changed nothing; Blender did not run');
    const afterText = bytes.toString('utf8');
    const change = scriptChange(f.beforeText, afterText);
    f.record.script.after = { sha256: now, bytes: bytes.length, lines: lineCount(afterText) };
    f.record.script.change = change;
    this.saveState(f);
    const syntax = await this.syntax(f, bytes, rel);
    f.record.script.syntax = syntax;
    if (this.stopped(f)) return this.end(f, 'cancelled', 'checks', 'stopped with /stop during the checks; Blender did not run');
    if (syntax.checked && !syntax.ok) return this.end(f, 'stopped', 'checks', `${rel} as the agent left it ${syntaxText(syntax)}; it is left as the agent wrote it; Blender did not run${kept}`);
    this.note(f, `agent ${a.agent} ${a.run} completed: changed ${rel} (${changeText(change)})${this.sep}${syntaxText(syntax)}`, syntax.checked ? 'secondary' : 'estimate');
    this.saveState(f);
  }

  /**
   * An AST parse of the script's bytes by this machine's python3 (`python3 -I -c …`, the bytes on stdin): nothing in
   * the script runs. No python3, or none that answers, is "not checked", with the reason.
   */
  private syntax(f: BlenderRun, bytes: Buffer, rel: string): Promise<SyntaxCheck> {
    const python = this.d.onPath('python3');
    if (!python) return Promise.resolve({ checked: false, why: 'no python3 on PATH' });
    return new Promise<SyntaxCheck>((resolve) => {
      let out = '';
      let settled = false;
      const done = (s: SyntaxCheck): void => { if (!settled) { settled = true; resolve(s); } };
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(python, ['-I', '-c', SYNTAX_CHECK_CODE, rel], { stdio: ['pipe', 'pipe', 'pipe'], signal: f.abort.signal, timeout: SYNTAX_TIMEOUT_MS });
      } catch (e) {
        done({ checked: false, why: `python3 did not start (${e instanceof Error ? e.message : String(e)})` });
        return;
      }
      child.stdout?.on('data', (b: Buffer) => { if (out.length < 65536) out += b.toString('utf8'); });
      child.stderr?.on('data', () => { /* drained: the answer is the JSON line */ });
      child.on('error', (e) => done({ checked: false, why: this.stopped(f) ? 'stopped with /stop' : `python3 did not run (${this.d.scrub(e.message, f.root)})` }));
      child.on('close', (code, signal) => {
        const parsed = parseSyntaxOutput(out);
        if (parsed?.ok) return done({ checked: true, ok: true, python: parsed.python, by: 'python3' });
        if (parsed) return done({ checked: true, ok: false, python: parsed.python, by: 'python3', error: parsed.error, line: parsed.line ?? null, offset: parsed.offset ?? null });
        done({ checked: false, why: `python3 gave no answer (${signal ? `ended by ${signal}` : `exit ${code}`})` });
      });
      child.stdin?.on('error', () => { /* it ended before reading all of it: its answer, or none, says what happened */ });
      child.stdin?.end(bytes);
    });
  }

  private async blenderStep(f: BlenderRun): Promise<void> {
    f.step = 'blender';
    if (this.stopped(f)) return this.end(f, 'cancelled', 'blender', 'stopped with /stop before Blender ran');
    const rel = f.record.script.path;
    const after = f.record.script.after!;
    let spec: NativeJobSpec;
    try {
      // /blender's own job: the read-only copy kept at submission runs; the run is judged by its own result file.
      spec = blenderJob({ script: rel, root: f.root, project: f.project, env: this.d.env(), label: `Blender · ${rel} · flow ${f.id}` });
    } catch (e) {
      const why = this.d.scrub(e instanceof NativeNotFound ? `${e.message}; ${e.setup}` : e instanceof Error ? e.message : String(e), f.root);
      f.record.blender = { state: 'not started', error: why };
      return this.end(f, 'failed', 'blender', `Blender did not start: ${why}`);
    }
    f.spec = spec;
    const m = spec.native;
    const b: NonNullable<BlenderFlowRecord['blender']> = { run: m.run, ...(m.record ? { record: relTo(m.root, m.record) } : {}), state: 'submitted', ...(m.copy ? { copy: { ...m.copy } } : {}) };
    f.record.blender = b;
    if (m.input?.sha256 !== after.sha256) {
      b.state = 'not started';
      return this.end(f, 'stopped', 'blender', `${rel} changed after it was checked (sha256 ${short(m.input?.sha256)} when submitted, ${short(after.sha256)} checked); Blender did not run`);
    }
    let job: JobRecord;
    try { job = this.d.startNative!(spec); } catch (e) {
      b.state = 'not started';
      b.error = this.d.scrub(e instanceof Error ? e.message : String(e), f.root);
      return this.end(f, 'failed', 'blender', `Blender did not start: ${b.error}`);
    }
    f.blenderJob = job.id;
    b.job = job.id;
    b.state = 'running';
    this.note(f, `Blender: ${job.id} runs ${rel} as submitted (its copy: ${m.copy?.path ?? 'none'})${this.sep}judged by its result file${this.sep}/jobs ${job.id}`);
    this.saveState(f);
    // A stop that came while the job was being started.
    if (this.stopped(f)) await this.d.jobs.stop(job.id);
    const done = await this.d.jobs.done(job.id);
    b.state = done.state;
    if (done.receipt) { b.receipt = done.receipt; f.record.receipts.blender = done.receipt; }
    const log = this.keepLog(f, done, 'blender.log');
    if (log) b.log = log.rel;
    if (this.stopped(f) || done.state === 'cancelled') {
      const when = done.state === 'cancelled' ? `during the Blender run (job ${job.id})` : `as the Blender run ended (job ${job.id} ${done.state}; its own receipt judges it)`;
      return this.end(f, 'cancelled', 'blender', `stopped with /stop ${when}; whatever it wrote is kept, and nothing was read back${b.log ? `; its output: ${b.log}` : ''}`);
    }
    // The run judged by its own result file (as /blender's end is): ok, failed or unknown, never by its exit alone.
    const j = judgeNativeJob(done, spec);
    b.outcome = j.outcome;
    b.why = this.d.scrub(j.why, f.root);
    if (typeof j.blenderVersion === 'string') b.blender_version = j.blenderVersion;
    b.files = j.files.filter((x) => !x.outside).map((x) => ({ path: x.path, ...(x.sha256 ? { sha256: x.sha256 } : {}), ...(x.change ? { change: x.change } : {}) }));
    /** the files the run's result names, as it named them (also when it says ok: false) */
    let named: string[] = [];
    if (m.result) {
      const resultSha = sha256File(m.result);
      b.result = { path: relTo(m.root, m.result), ...(resultSha ? { sha256: resultSha } : {}) };
      const read = readNativeResult(m.result);
      if (read.state === 'read') {
        b.reported = reportedByResult(read.data);
        const files = (read.data as { files?: unknown } | null)?.files;
        if (files && typeof files === 'object' && !Array.isArray(files)) named = Object.keys(files);
      }
    }
    if (j.outcome !== 'ok') {
      // Its raw failure stays where it was written: the result file (its error and traceback), the verdicts, its output,
      // and whatever it wrote before it failed (a scene saved before a render that failed).
      const written = named.flatMap((n) => {
        const at = resolveInside(m.root, n);
        return !('error' in at) && existsSync(at.path) ? [at.rel] : [];
      });
      const keptFiles = [...new Set([
        ...(b.result?.sha256 ? [b.result.path] : []),
        ...(m.record && existsSync(path.join(m.record, 'verdicts.jsonl')) ? [`${relTo(m.root, m.record)}/verdicts.jsonl`] : []),
        ...(b.log ? [b.log] : []),
        ...b.files.filter((x) => x.sha256).map((x) => x.path),
        ...written,
      ])];
      b.failure_files = keptFiles;
      return this.end(f, 'failed', 'blender', `Blender's run is judged ${j.outcome}, not ok: ${b.why}; nothing was read back${keptFiles.length ? `; kept: ${keptFiles.join(', ')}` : ''}`);
    }
    const blends = b.files.filter((x) => BLEND.test(x.path) && x.sha256);
    if (blends.length === 1) b.blend = { path: blends[0].path, sha256: blends[0].sha256! };
    b.renders = b.files.filter((x) => IMAGE.test(x.path) && x.sha256).map((x) => ({ path: x.path, sha256: x.sha256! }));
    this.saveState(f);
  }

  private async readbackStep(f: BlenderRun): Promise<void> {
    f.step = 'readback';
    const b = f.record.blender!;
    const spec = f.spec!;
    const r: NonNullable<BlenderFlowRecord['readback']> = { state: 'not started', scope: BLEND_READBACK_SCOPE };
    f.record.readback = r;
    const blends = (b.files ?? []).filter((x) => BLEND.test(x.path));
    if (blends.length !== 1 || !b.blend) {
      r.verdict = 'failed';
      r.reason = blends.length ? `the run's result names ${blends.length} .blend files (${blends.map((x) => x.path).join(', ')}), and the second pass reads one` : 'the run\'s result names no .blend file';
      return this.end(f, 'failed', 'readback', `${r.reason}; nothing was read back`);
    }
    const blend = b.blend;
    if (this.stopped(f)) { r.state = 'cancelled'; return this.end(f, 'cancelled', 'readback', 'stopped with /stop before the second pass started; Blender\'s run had finished'); }
    const abs = path.join(spec.native.root, ...blend.path.split('/'));
    // Timmy's own sha256 of the file, before the second pass: it must be the bytes the judged run recorded.
    const before = sha256File(abs);
    if (!before || before !== blend.sha256) {
      r.verdict = 'failed';
      r.reason = `${blend.path} ${before ? `changed after Blender's run was judged (sha256 ${short(before)} now, ${short(blend.sha256)} then)` : 'is gone, or cannot be read'}`;
      return this.end(f, 'failed', 'readback', `${r.reason}; nothing was read back`);
    }
    r.blend = { path: blend.path, sha256_before: before };
    const env = this.d.env();
    let job: JobRecord;
    try {
      job = this.d.startJob({
        kind: 'task', label: `readback ${blend.path} in Blender · flow ${f.id}`, project: f.project, root: spec.native.root,
        // The same Blender as the run, in its own process: it opens the file, then the worker prints what it holds.
        command: spec.command, args: ['-b', abs, '--factory-startup', '--python-exit-code', '1', '--python', BLEND_READBACK_SCRIPT, '--', '--as', blend.path],
        env: { ...env, ...(env.TIMMY_NATIVE_HOME ? { HOME: env.TIMMY_NATIVE_HOME } : {}) }, timeoutMs: BLEND_READBACK_TIMEOUT_MS,
      }, { selfSealed: true });
    } catch (e) {
      r.verdict = 'failed';
      r.reason = this.d.scrub(e instanceof Error ? e.message : String(e), f.root);
      return this.end(f, 'failed', 'readback', `the second pass did not start: ${r.reason}`);
    }
    f.readbackJob = job.id;
    r.job = job.id;
    r.state = 'running';
    this.note(f, `second pass: ${job.id} opens ${blend.path} in a separate Blender process and reads it back${this.sep}/jobs ${job.id}`);
    this.saveState(f);
    if (this.stopped(f)) await this.d.jobs.stop(job.id);
    const done = await this.d.jobs.done(job.id);
    const log = this.keepLog(f, done, 'readback.log');
    if (log) r.log = log.rel;
    r.state = done.state;
    const after = sha256File(abs);
    if (after) r.blend.sha256_after = after;
    const finish = (verdict: BlendVerdict | undefined, outcome: Exclude<BlenderFlowRecord['outcome'], 'running'>, why: string): void => {
      if (verdict) r.verdict = verdict;
      const receipt = this.sealReadback(f, done, log);
      if (receipt) { r.receipt = receipt; f.record.receipts.readback = receipt; }
      this.end(f, outcome, 'readback', why);
    };
    if (this.stopped(f) || done.state === 'cancelled') {
      r.state = 'cancelled';
      r.reason = 'stopped with /stop before it finished: no verdict';
      return finish(undefined, 'cancelled', `stopped with /stop during the second pass; Blender's run had finished; no verdict${r.log ? `; its output so far: ${r.log}` : ''}`);
    }
    let size = 0;
    try { size = statSync(done.logPath).size; } catch { size = 0; }
    const parsed: BlendReadback | BlendReadbackFailure = size > BLEND_READBACK_MAX_OUTPUT
      ? { ok: false, code: 'too-much-output', error: `the second pass printed more than ${BLEND_READBACK_MAX_OUTPUT} bytes` }
      : parseBlendReadback(this.d.jobs.tail(job.id, 400).join('\n'));
    if (parsed.worker) r.worker = parsed.worker;
    const kept = r.log ? `; its output is kept: ${r.log}` : '';
    if (!parsed.ok) {
      r.reason = this.d.scrub(`${parsed.code}: ${parsed.error}`, f.root);
      return finish('failed', 'failed', `the second pass failed: ${r.reason}${done.state !== 'completed' ? ` (${exitWords(done)})` : ''}${kept}`);
    }
    r.blender_version = parsed.blender_version;
    if (done.state !== 'completed') {
      r.reason = `the second pass reported values but ${exitWords(done)}`;
      return finish('failed', 'failed', `the second pass failed: ${r.reason}${kept}`);
    }
    if (after !== before) {
      r.reason = `${blend.path} changed while it was read back (sha256 ${short(before)} before, ${after ? short(after) : 'gone'} after)`;
      return finish('failed', 'failed', `the second pass failed: ${r.reason}`);
    }
    if (parsed.file.opened !== blend.path) {
      r.reason = `Blender opened ${parsed.file.opened ?? 'a file it did not name'}, not ${blend.path}`;
      return finish('failed', 'failed', `the second pass failed: ${r.reason}${kept}`);
    }
    r.read = parsed.read;
    const cmp = compareBlendReadback(b.reported ?? {}, parsed.read);
    r.checks = cmp.checks;
    const made = cmp.checks.filter((c) => c.passed !== null).map((c) => c.name).join(', ');
    if (cmp.verdict === 'matches') return finish('matches', 'succeeded', `the second pass over ${blend.path} matches what Blender's run reported (${made})`);
    if (cmp.verdict === 'differs') return finish('differs', 'differs', `the second pass over ${blend.path} differs from what Blender's run reported: ${differencesText(cmp.checks)}`);
    r.reason = cmp.reason;
    return finish('failed', 'failed', `the second pass read ${blend.path}, but ${cmp.reason}`);
  }

  /** The second pass's receipt (kind readback): what it read (in sources: it changed nothing), its job, what it read and the verdict. */
  private sealReadback(f: BlenderRun, job: JobRecord, log?: { rel: string; sha256: string; bytes: number }): string | undefined {
    const r = f.record.readback!;
    const ms = job.endedAt ? Date.parse(job.endedAt) - Date.parse(job.startedAt) : undefined;
    const read = r.read;
    const failing = (r.checks ?? []).filter((c) => c.passed === false).map((c) => `${c.name}: ${c.differences.join('; ')}`);
    try {
      return this.d.seal({
        kind: 'readback', subject: `readback · ${r.blend?.path ?? '.blend'} · ${r.verdict ?? r.state}`, policy: 'human-gated',
        status: r.verdict === 'matches' ? 'ok' : r.state === 'cancelled' ? 'cancelled' : 'failed',
        project: f.project, project_id: projectId(f.root),
        job: { id: job.id, kind: job.kind, label: this.d.scrub(job.label, f.root), state: job.state, exit_code: job.exitCode ?? null, ...(ms !== undefined ? { ms } : {}), ...(job.error ? { error: this.d.scrub(job.error, f.root) } : {}) },
        ...(log ? { outputs: [{ path: log.rel, sha256: log.sha256, bytes: log.bytes }] } : {}),
        sources: [
          ...(r.blend ? [{ path: r.blend.path, sha256: r.blend.sha256_before, ...(r.blend.sha256_after ? { sha256_after: r.blend.sha256_after } : {}), role: 'read' }] : []),
          {
            flow: f.id, worker: r.worker ? `${r.worker.name} ${r.worker.version}` : null, blender_version: r.blender_version ?? null,
            read: read ? { objects: read.objects_total, materials: read.materials.length, materials_used: read.materials_used, active_camera: read.active_camera, frame_range: read.frame_range, render_resolution: read.render_resolution } : null,
            checks: (r.checks ?? []).map((c) => ({ name: c.name, passed: c.passed, ...(c.tolerance !== undefined ? { tolerance: c.tolerance } : {}) })), verdict: r.verdict ?? null, scope: BLEND_READBACK_SCOPE, units: 'Blender units',
          },
        ],
        ...(f.record.receipts.blender ? { child_receipts: [f.record.receipts.blender] } : {}),
        ...(failing.length ? { discrepancies: failing } : r.reason ? { discrepancies: [r.reason] } : {}),
      });
    } catch { return undefined; }
  }

  /** The record (results/flows/<flow-id>.json), the flow receipt binding its sha256 and the child receipts, the notice. */
  private finish(f: BlenderRun): BlenderFlowRecord {
    f.step = 'record';
    const rec = f.record;
    rec.ended_at = new Date().toISOString();
    // R4 (H37): the objects' sizes before and after, when Blender's run was judged ok and reported them
    const after = rec.blender?.outcome === 'ok' ? rec.blender.reported?.bounds : undefined;
    if (after) {
      const check = rec.readback?.checks?.find((c) => c.name === 'dimensions');
      const before = f.before?.ok ? f.before.before : null;
      rec.dimensions = dimensionsSummary({
        after, before, ...(f.before && !f.before.ok ? { beforeWhy: f.before.why } : {}), ...(check ? { check } : {}),
        notCompared: rec.readback?.reason ?? (rec.readback ? rec.why : 'the second pass did not run'),
      });
    }
    const r = rec.receipts;
    rec.child_receipts = [r.agent, r.blender, r.readback].filter((x): x is string => typeof x === 'string');
    const w = writeProjectJson(f.root, flowRecordPath(f.id), rec);
    const status = rec.outcome === 'succeeded' ? 'ok' as const : rec.outcome === 'cancelled' ? 'cancelled' as const : 'failed' as const;
    const cost = rec.agent?.cost_usd;
    let receipt: string | undefined;
    try {
      receipt = this.d.seal({
        kind: 'flow', subject: `flow · iterate · blender · ${f.id} · ${rec.outcome}`, policy: 'human-gated', status,
        project: f.project, project_id: projectId(f.root),
        prompt_hash: `sha256:${sha(rec.instruction)}`,
        ...(w.ok ? { outputs: [{ path: w.path, sha256: w.sha256, bytes: w.bytes }] } : { discrepancies: [`the flow record could not be written: ${this.d.scrub(w.error, f.root)}`] }),
        sources: [{ path: rec.script.path, sha256: rec.script.before.sha256, ...(rec.script.after ? { sha256_after: rec.script.after.sha256 } : {}), role: 'the script the agent was asked to change' }],
        ...(rec.child_receipts.length ? { child_receipts: rec.child_receipts } : {}),
        // The agent's cost as its own receipt sealed it: 0 on a local endpoint; unknown is never written as 0.
        ...(typeof cost === 'number' ? { cost_usd: cost } : cost === null ? { cost_measured: false } : {}),
      });
    } catch { receipt = undefined; }
    f.receipt = receipt;
    if (w.ok) f.recordFile = w.path;
    this.saveState(f);
    f.step = 'done';
    for (const l of this.endLines(f, w.ok ? w.path : undefined, receipt)) this.d.notify(l);
    return rec;
  }

  private endLines(f: BlenderRun, file: string | undefined, receipt: string | undefined): Line[] {
    const g = this.d.glyphs;
    const rec = f.record;
    const ok = rec.outcome === 'succeeded';
    const tail = `${file ? `${this.sep}record ${file}` : `${this.sep}the record could not be written`}${receipt ? `${this.sep}receipt ${receipt}` : ''}`;
    const lines: Line[] = [[{ text: `  ${ok ? g.ok : rec.outcome === 'cancelled' ? ' ' : g.fail} `, role: ok || rec.outcome === 'cancelled' ? undefined : 'failure' },
      { text: `${f.id} ${rec.outcome}`, role: ok || rec.outcome === 'cancelled' ? 'strong' : 'failure' }, { text: `: ${rec.why ?? ''}${tail}`, role: 'secondary' }]];
    // R4 review (R4-2): what the check of the agent's changes did not look into, never skipped silently.
    const unseen = notComparedText(rec.agent?.compared);
    if (unseen) lines.push([{ text: `      not compared while the agent ran: ${unseen}`, role: 'secondary' }]);
    const k = rec.readback;
    const read = k?.read;
    if (k && read) {
      const objects = read.objects.map((o) => o.name);
      const shown = `${objects.slice(0, 8).join(', ')}${objects.length > 8 ? ', …' : ''}`;
      lines.push([{ text: `      read back from ${k.blend?.path ?? 'the .blend'}: `, role: 'secondary' }, {
        text: `${read.objects_total} object${read.objects_total === 1 ? '' : 's'} (${shown}), ${read.materials_used.length} material${read.materials_used.length === 1 ? '' : 's'} in use, camera ${read.active_camera ?? 'none'}${read.frame_range ? `, frames ${read.frame_range.join('–')}` : ''}${read.render_resolution ? `, ${read.render_resolution.join(' x ')}` : ''}`,
        role: 'strong',
      }, { text: `${this.sep}${k.worker ? `${k.worker.name} ${k.worker.version}` : 'worker unknown'}${k.blender_version ? `${this.sep}Blender ${k.blender_version}` : ''}${this.sep}${k.verdict ?? 'no verdict'}`, role: 'secondary' }]);
      lines.push([{ text: `      ${BLEND_READBACK_SCOPE}`, role: 'secondary' }]);
    }
    // R4 (H37): only the objects whose size changed, and a count of the rest; where the sizes before come from
    if (rec.dimensions) {
      const t = dimensionsText(rec.dimensions, 6);
      lines.push([{ text: '      sizes: ', role: 'secondary' }, { text: t.sizes, role: rec.dimensions.after.agrees === false ? 'failure' : 'strong' }]);
      lines.push([{ text: `      ${t.detail}`, role: 'secondary' }]);
      lines.push([{ text: `      ${DIMENSIONS_SCOPE} ${DOCTRINE_15}`, role: 'secondary' }]);
    }
    return lines;
  }

  // ── stopping ─────────────────────────────────────────────────────────────────

  /** `/stop <flow-id>` for a Blender flow: stops the step that runs, waits for the record, and says what happened. */
  async stop(id: string): Promise<Line[]> {
    const f = this.running.get(id);
    if (!f) return this.say(`No flow ${id} is running in this REPL: /iterate lists the flows.`);
    const step = f.step;
    f.abort.abort();
    if (step === 'agent' && f.agentJob) await this.d.jobs.stop(f.agentJob);
    else if (step === 'blender' && f.blenderJob) await this.d.jobs.stop(f.blenderJob);
    else if (step === 'readback' && f.readbackJob) await this.d.jobs.stop(f.readbackJob);
    const rec = f.done ? await within(f.done, 60_000) : undefined;
    if (!rec) return this.say(`${id}: stopping (it was in the ${step} step); its record is not written yet: /iterate`, 'estimate');
    return [[{ text: `  ${id} ${rec.outcome}`, role: rec.outcome === 'cancelled' ? 'strong' : 'failure' },
      { text: `  ${rec.why ?? ''}${f.recordFile ? `${this.sep}record ${f.recordFile}` : ''}${f.receipt ? `${this.sep}receipt ${f.receipt}` : ''}`, role: 'secondary' }]];
  }

  /**
   * /stop all and the REPL's end: every Blender flow is marked stopped, so none starts a next step (the jobs themselves
   * are stopped by the caller, as this REPL's jobs). How many were running, their records to wait for, and how each ended.
   */
  abortAll(): { count: number; done: Array<Promise<unknown>>; describe: () => string[] } {
    const live = [...this.running.values()];
    for (const f of live) f.abort.abort();
    return {
      count: live.length,
      done: live.map((f) => f.done ?? Promise.resolve()),
      describe: () => live.map((f) => `${f.id} ${f.step === 'done' ? f.record.outcome : `still stopping (in its ${f.step} step)`}`),
    };
  }

  /** The records of the Blender flows running now, to wait for. */
  pending(): Array<Promise<unknown>> { return [...this.running.values()].map((f) => f.done ?? Promise.resolve()); }
}

const relTo = (root: string, abs: string): string => path.relative(root, abs).split(path.sep).join('/');

/**
 * Keeps bytes in the project (the flow's folder in .timmy, which the agent's comparison does not look into), written
 * once, never through a link that leads out of the project; its project-relative path, or undefined when it could
 * not be kept (the flow goes on without it).
 */
function keepBytes(root: string, rel: string, bytes: Buffer): string | undefined {
  const dir = resolveInside(root, path.posix.dirname(rel));
  if ('error' in dir) return undefined;
  let fd: number | undefined;
  try {
    mkdirSync(dir.path, { recursive: true });
    const again = resolveInside(root, rel);
    if ('error' in again) return undefined;
    fd = openSync(again.path, 'wx', 0o444);
    writeSync(fd, bytes);
    return rel;
  } catch { return undefined; } finally { if (fd !== undefined) closeSync(fd); }
}
