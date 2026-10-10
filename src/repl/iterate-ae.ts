/**
 * /iterate ae in the REPL (round R4, helper H41): the After Effects variant of the connected workflow, one flow with its own
 * id (f + 8 hex), run beside the other flows (src/repl/iterate.ts parses the line and hands it here):
 *
 *   1. before anything starts: the script is a .jsx (or .js) in the project, reached through no link, outside .git,
 *      node_modules, .timmy and dist (the agent's before/after comparison does not look there), at most 256 KB; After
 *      Effects (scripting) and aerender are found; the agent's route is local and free. Its bytes are read and kept in the
 *      flow's folder (script.before.jsx);
 *   2. a local code agent runs through /agent's own start, told to change only that script and to keep it ExtendScript;
 *   3. after it: any other file changed, the script deleted, or changed after the agent ended, no change, or a script that
 *      no longer compiles stops the flow before After Effects runs (Node's vm.Script compiles it, never runs it: a
 *      modern-JavaScript compile check of ExtendScript (ES3) source, not After Effects' parser). Nothing is reverted;
 *   4. `/ae author <script> --name <stem>` as the judged native job (src/native/ae-author.ts aeScriptJob, started and
 *      adopted as /ae's: its end notice and its native receipt are /ae's): a new version, out/ae/<stem>-v<N>.aep, and After
 *      Effects' own report of the project;
 *   5. aerender renders the first comp After Effects reported (or --comp <name>) to out/ae/<stem>-v<N>.mp4 (--om <template>
 *      passed as -OMtemplate), as /ae's render job; the file it wrote is judged by the rule for a file of the same name with
 *      another extension (its output module decides the container);
 *   6. the readback: workers/readback/video_readback.py, this machine's python3 with ffprobe and ffmpeg (TIMMY_FFPROBE and
 *      TIMMY_FFMPEG, or on PATH), reads the render outside After Effects, and Timmy compares it with After Effects' report:
 *      the comp's size, frame rate, duration and frame count, and each solid's centroid against where its Position keys put
 *      it (src/flows/iterate-ae.ts). Its verdict is the flow's: matches, differs or failed. Without ffprobe, ffmpeg or
 *      python3 the flow ends after the render as "succeeded without readback", with the setup step, never "matches";
 *   7. the flow record (results/flows/<flow-id>.json) and a `flow` receipt binding its sha256 and the child receipts (the
 *      agent's, the author run's, the render's, the readback's). Every raw failure stays where it was written, and the
 *      record names it.
 *
 * /stop <flow-id> stops the step that runs: the agent's job, After Effects' job, aerender's job, the readback's job. /stop
 * all and the REPL's end stop every flow. The structure mirrors src/repl/iterate-blender.ts and iterate-native.ts (their
 * code COPIED where it is the same, not moved: other helpers edit those files this round).
 */
import { accessSync, closeSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { JobRecord } from '../jobs/index.js';
import { AGENTS, AGENTS_DIR, agentBin, planAgent, type AgentName, type AgentPlan, type AgentRunRecord } from '../code-agents/index.js';
import { codexLocalPreflight } from '../code-agents/codex-local.js';
import { aerenderJob, judgeNativeJob, locateNative, NATIVE_APPS, NativeNotFound, sha256File, type NativeJobSpec } from '../native/index.js';
import { aeCompsLine, aeScriptJob, aeStem, judgeAeJob, type AeCompReport, type AeJobSpec } from '../native/ae-author.js';
import { projectId, resolveInside } from '../project/index.js';
import { DOCTRINE_15, FLOW_SCHEMA, flowRecordPath, flowWorkDir, newFlowId, writeProjectJson } from '../flows/iterate.js';
import {
  AE_FFMPEG_SETUP, AE_FILE_MAX_BYTES, AE_READBACK_LABEL, AE_RENDER_EXT, AE_REPORTED_BY, aeIterateTask, changeText, chooseComp, compareAeReadback, compFacts,
  compileCheck, compileWords, differencesText, factsChanges, judgeFileChanges, lineCount, parseVideoReadback, planReadback, previousAeAuthor, reportedComps,
  scriptChange, unseenFolder, VIDEO_READBACK_MAX_OUTPUT, VIDEO_READBACK_SCRIPT, VIDEO_READBACK_TIMEOUT_MS, type AeFlowRecord, type AeFlowStep, type AeReadbackPlan,
  type VideoReadback, type VideoReadbackFailure,
} from '../flows/iterate-ae.js';
import type { IterateDeps } from './iterate.js';
import type { Segment } from '../term/theme.js';

type Line = Segment[];

export const AE_ITERATE_USAGE = '/iterate ae <script.jsx> "<instruction>" [--comp <name>] [--om <template>] [--agent qwen|codex] [--model <local model>]';

/** `/iterate ae <script.jsx> "<instruction>"`, parsed (src/repl/iterate.ts parseIterateLine). */
export interface AeIterateRequest { recipe: 'ae'; file: string; instruction: string; agent: AgentName; model?: string; comp?: string; om?: string }

/**
 * /iterate ae's own options, taken out of the words after the script (the rest, --agent and --model and the instruction,
 * are parsed as for every target): `--comp <name>` (the comp to render; the first After Effects reports when absent) and
 * `--om <template>` (an output module template, passed to aerender as -OMtemplate: After Effects' own name, not checked).
 * Each as `--x value` or `--x=value`, once. The words are changed in place.
 */
export function takeAeOptions(words: string[]): { comp?: string; om?: string } | { error: string } {
  const out: { comp?: string; om?: string } = {};
  for (let i = 0; i < words.length;) {
    const m = /^--(comp|om)(?:=(.*))?$/.exec(words[i]);
    if (!m) { i++; continue; }
    const key = m[1] as 'comp' | 'om';
    const value = m[2] ?? words[i + 1];
    if (value === undefined || (m[2] === undefined && value.startsWith('--')) || !value.trim()) return { error: `--${key} needs a value. Usage: ${AE_ITERATE_USAGE}` };
    if (out[key] !== undefined) return { error: `--${key} is given twice. Usage: ${AE_ITERATE_USAGE}` };
    out[key] = value;
    words.splice(i, m[2] === undefined ? 2 : 1);
  }
  return out;
}

interface AeRun {
  id: string;
  root: string;
  project: string;
  record: AeFlowRecord;
  abort: AbortController;
  step: AeFlowStep | 'done';
  /** the script's text as read before the agent ran (the change is summarised against it) */
  beforeText: string;
  /** the project's name in out/ae: the script's stem */
  name: string;
  agentJob?: string;
  agentRecord?: AgentRunRecord;
  authorJob?: string;
  renderJob?: string;
  readbackJob?: string;
  /** the comp chosen to render, as After Effects reported it */
  comp?: AeCompReport;
  /** an earlier judged-ok /ae author run of the script as it was, found when the flow started */
  before?: { run: string; job?: string; started_at: string } | { none: string };
  done?: Promise<AeFlowRecord>;
  receipt?: string;
  recordFile?: string;
}

type Started = { ok: true; flow: AeRun; lines: Line[] } | { ok: false; error: string; lines: Line[] };
type Refusal = { ok: false; error: string; role: Segment['role'] };
type Tools = { ready: true; python: string; ffprobe: string; ffmpeg: string } | { ready: false; why: string };

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const short = (s: string | null | undefined): string => (s ? s.slice(0, 12) : '?');
/** R4 (H46): its timer holds the event loop while awaited (unref'd, Node could exit under a typed command) and is cleared once `p` settles. */
const within = <T>(p: Promise<T>, ms: number): Promise<T | undefined> => {
  let t: NodeJS.Timeout | undefined;
  return Promise.race([p, new Promise<undefined>((resolve) => { t = setTimeout(() => resolve(undefined), ms); })]).finally(() => clearTimeout(t));
};
const relTo = (root: string, abs: string): string => path.relative(root, abs).split(path.sep).join('/');
const exitWords = (j: JobRecord): string => j.error ?? (j.signal ? `ended by ${j.signal}` : `exited ${j.exitCode ?? '?'}`);
const SCRIPT = /\.(jsx|js)$/i;
const n3 = (n: number | null | undefined): string => (typeof n === 'number' && Number.isFinite(n) ? String(Math.round(n * 1000) / 1000) : '?');
/** The kept-file names a failed run leaves, that exist. */
const kept = (root: string, names: string[]): string[] => [...new Set(names)].filter((n) => { try { lstatSync(path.join(root, n)); return true; } catch { return false; } });
const runnable = (file: string): boolean => { try { if (!statSync(file).isFile()) return false; accessSync(file, constants.X_OK); return true; } catch { return false; } };

/** COPIED from src/repl/iterate-native.ts: bytes kept once, read-only, in the flow's folder; its path, or undefined. */
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

export class AeFlows {
  private readonly running = new Map<string, AeRun>();
  /** a flow being started in a project (its agent is starting), by the project's folder: it holds the project already */
  private readonly starting = new Map<string, string>();

  /** `busyElsewhere`: a flow of another kind running in a project (one flow at a time runs in a project, of any kind). */
  constructor(private readonly d: IterateDeps, private readonly busyElsewhere: (root: string) => { id: string; step: string } | undefined) {}

  private get sep(): string { return ` ${this.d.glyphs.sep} `; }
  private say(text: string, role: Segment['role'] = 'secondary'): Line[] { return [[{ text: `  ${text}`, role }]]; }
  private refuse(error: string, role: Segment['role'] = 'failure', more: Line[] = []): Started { return { ok: false, error, lines: [...this.say(error, role), ...more] }; }

  /** The After Effects flows this REPL is running (their ids). */
  get active(): string[] { return [...this.running.keys()]; }
  has(id: string): boolean { return this.running.has(id); }
  /** The flow running (or being started) in this project, if one is. */
  runningIn(root: string): { id: string; step: string } | undefined {
    const f = [...this.running.values()].find((x) => x.root === root);
    if (f) return { id: f.id, step: f.step };
    const starting = this.starting.get(root);
    return starting ? { id: starting, step: 'prepare' } : undefined;
  }

  /** /iterate's rows for the After Effects flows running in this project. */
  runningRows(root: string): Line[] {
    return [...this.running.values()].filter((f) => f.root === root).map((f) => [{ text: `    ${this.d.glyphs.bullet} ` }, { text: f.id, role: 'strong' as const },
      { text: `  running: the ${f.step} step${this.sep}/stop ${f.id}${this.sep}ae ${f.record.script.path}: ${this.d.scrub(f.record.instruction, root).slice(0, 50)}`, role: 'secondary' as const }]);
  }

  /** Whether the readback could run after the render: python3, ffprobe and ffmpeg found (said, never run here). */
  private tools(env: NodeJS.ProcessEnv): Tools {
    if (!existsSync(VIDEO_READBACK_SCRIPT)) return { ready: false, why: 'the readback worker (workers/readback/video_readback.py) is missing from this Timmy' };
    const python = this.d.onPath('python3');
    if (!python) return { ready: false, why: 'no python3 on PATH (the readback worker is a Python 3 script)' };
    const find = (tool: 'ffprobe' | 'ffmpeg'): { path: string } | { why: string } => {
      const v = `TIMMY_${tool.toUpperCase()}`;
      const given = env[v]?.trim();
      if (given) return runnable(given) ? { path: given } : { why: `${v} is set, but nothing runnable is there` };
      const found = this.d.onPath(tool);
      return found ? { path: found } : { why: `${tool} is not on PATH and ${v} is not set` };
    };
    const probe = find('ffprobe');
    const mpeg = find('ffmpeg');
    if ('why' in probe || 'why' in mpeg) return { ready: false, why: [...('why' in probe ? [probe.why] : []), ...('why' in mpeg ? [mpeg.why] : [])].join('; ') };
    return { ready: true, python, ffprobe: probe.path, ffmpeg: mpeg.path };
  }

  /** /iterate's usage lines for the After Effects flow: whether After Effects and aerender are found and the readback can run (found is not run). */
  usageLines(): Line[] {
    const env = this.d.env();
    const ae = locateNative('afterfx', env);
    const render = locateNative('aerender', env);
    const tools = this.tools(env);
    const how = (f: { how: string }): string => (f.how === 'env' ? 'set by its variable' : f.how === 'applications' ? 'in /Applications' : 'on PATH');
    return [
      [{ text: '  AE         ', role: 'secondary' }, { text: AE_ITERATE_USAGE, role: 'strong' }],
      ...this.say('           the agent may change only that script; After Effects runs it as /ae author does; aerender renders a comp; the render is read back outside After Effects and compared with After Effects\' report'),
      ae.found && render.found
        ? [{ text: '             ', role: 'secondary' }, { text: `After Effects found (${how(ae.found)}), aerender found (${how(render.found)})`, role: 'strong' }, { text: `${this.sep}they run when a flow does, not now`, role: 'secondary' }]
        : [{ text: '             ', role: 'secondary' }, { text: `${ae.found ? '' : `${NATIVE_APPS.afterfx.name} not found${ae.problem ? ` (${ae.problem})` : ''}`}${!ae.found && !render.found ? '; ' : ''}${render.found ? '' : `${NATIVE_APPS.aerender.name} not found${render.problem ? ` (${render.problem})` : ''}`}`, role: 'estimate' }, { text: `${this.sep}${NATIVE_APPS.afterfx.setup}`, role: 'secondary' }],
      tools.ready
        ? [{ text: '             ', role: 'secondary' }, { text: 'the readback can run (python3, ffprobe and ffmpeg found)', role: 'strong' }, { text: `${this.sep}checked when a flow reaches it, not now`, role: 'secondary' }]
        : [{ text: '             ', role: 'secondary' }, { text: `no readback: ${tools.why}`, role: 'estimate' }, { text: `${this.sep}a flow then ends after the render, succeeded without readback${this.sep}${AE_FFMPEG_SETUP}`, role: 'secondary' }],
    ];
  }

  // ── before the agent ───────────────────────────────────────────────────────────

  /** The agent's route, before anything is written: a local, free one (Qwen Code, or Codex's local route), or why not. */
  private route(req: AeIterateRequest, env: NodeJS.ProcessEnv, root: string): { ok: true; local: { local?: true }; plan: AgentPlan } | Refusal {
    const info = AGENTS[req.agent];
    const bin = agentBin(req.agent, env, this.d.onPath);
    if (!bin) return { ok: false, role: 'estimate', error: `${info.title} is not on PATH (${info.bin}); /tools says how to install it. Nothing was started.` };
    if (!env.TIMMY_AGENT_MODEL?.trim()) return { ok: false, role: 'failure', error: `Name the local model: ${AE_ITERATE_USAGE.replace('[--model <local model>]', '--model <a model your local endpoint serves, from ollama list>')}, or set TIMMY_AGENT_MODEL. Nothing was started.` };
    const local = req.agent === 'codex' ? { local: true as const } : {};
    const planned = planAgent(req.agent, req.instruction, { env, paid: false, run: 'a00000000', bin, ...local, root });
    if (!planned.ok) {
      const why = planned.error.replace(/\s*To run it anyway:.*$/, '');
      return planned.refused === 'paid' ? { ok: false, role: 'estimate', error: `${why} /iterate runs only a local, free route, and has no --paid.` } : { ok: false, role: 'failure', error: why };
    }
    return { ok: true, local, plan: planned.plan };
  }

  async start(req: AeIterateRequest, at: { root: string; project: string }): Promise<Started> {
    const { root, project } = at;
    const scrub = (t: string): string => this.d.scrub(t, root);
    const env: NodeJS.ProcessEnv = { ...this.d.env(), ...(req.model ? { TIMMY_AGENT_MODEL: req.model } : {}) };
    // The script first: a regular .jsx (or .js) in the project, reached through no link, where the agent's comparison sees it.
    const found = resolveInside(root, req.file);
    if ('error' in found) return this.refuse(`${scrub(found.error)}. Nothing was started.`);
    const rel = found.rel;
    if (/\.jsxbin$/i.test(rel)) return this.refuse(`${rel} is an encoded ExtendScript (.jsxbin), which an agent cannot edit: /iterate ae changes a .jsx script. Nothing was started.`);
    if (!SCRIPT.test(rel)) return this.refuse(`${rel} is not an After Effects script (.jsx): /iterate ae changes an ExtendScript authoring script. Nothing was started.`);
    const hidden = unseenFolder(rel);
    if (hidden) return this.refuse(`${rel} is inside ${hidden}/, which the agent's before/after comparison does not look into, so a change to it could not be seen: keep the script elsewhere in the project. Nothing was started.`);
    let realRoot: string;
    try { realRoot = realpathSync(root); } catch { return this.refuse('The project folder is gone. Nothing was started.'); }
    let st;
    try { st = lstatSync(found.path); } catch { return this.refuse(`No script at ${rel}: /project new <name> --from ae-starter makes a project with one (author.jsx). Nothing was started.`); }
    if (found.path !== path.join(realRoot, ...rel.split('/')) || st.isSymbolicLink()) return this.refuse(`${rel} is reached through a symbolic link, and the agent's before/after comparison sees the link, not the file: name the file itself. Nothing was started.`);
    if (!st.isFile()) return this.refuse(`${rel} is not a regular file. Nothing was started.`);
    if (st.size > AE_FILE_MAX_BYTES) return this.refuse(`${rel} is ${st.size} bytes: /iterate ae gives the agent the whole script, and takes scripts up to ${AE_FILE_MAX_BYTES / 1024} KB. Nothing was started.`);
    // The route: local and free, or refused with the reason.
    const route = this.route(req, env, root);
    if (!route.ok) return this.refuse(route.error, route.role);
    // One flow at a time in a project: an agent's before/after comparison covers the whole project.
    const busy = this.runningIn(root) ?? this.busyElsewhere(root);
    if (busy) return this.refuse(`Flow ${busy.id} is still running in this project (its ${busy.step} step), and one flow at a time runs in a project (an agent's before/after comparison covers all of it): wait for it, or /stop ${busy.id}. Nothing was started.`, 'estimate');
    // After Effects and aerender before the agent works: they run after it, so they come first.
    const ae = locateNative('afterfx', env);
    if (!ae.found) return this.refuse(`Not started: ${NATIVE_APPS.afterfx.name} was not found on this machine${ae.problem ? ` (${ae.problem})` : ''}. /iterate ae runs After Effects after the agent, so it comes first.`, 'estimate', this.say(`Setup: ${NATIVE_APPS.afterfx.setup}, then /iterate again.`));
    const render = locateNative('aerender', env);
    if (!render.found) return this.refuse(`Not started: ${NATIVE_APPS.aerender.name} was not found on this machine${render.problem ? ` (${render.problem})` : ''}. /iterate ae renders with aerender after After Effects runs the script, so it comes first.`, 'estimate', this.say(`Setup: ${NATIVE_APPS.aerender.setup}, then /iterate again.`));
    if (!this.d.startNative) return this.refuse('Not started: this REPL cannot start a native job.');
    const id = newFlowId();
    // Codex's local route needs its model already in the local Ollama: asked before anything is written, the project held
    // while it is asked, so no second flow starts meanwhile.
    if (route.plan.oss) {
      this.starting.set(root, id);
      let ready: Awaited<ReturnType<typeof codexLocalPreflight>>;
      try { ready = await codexLocalPreflight(route.plan.oss); } finally { this.starting.delete(root); }
      if (!ready.ok) return this.refuse(scrub(ready.error), 'estimate');
    }
    // The script's bytes now: the task quotes them, their sha256 is the "before" every later check compares with.
    let bytes: Buffer;
    try { bytes = readFileSync(found.path); } catch (e) { return this.refuse(`${rel} could not be read: ${scrub(e instanceof Error ? e.message : String(e))}. Nothing was started.`); }
    const beforeText = bytes.toString('utf8');
    const name = aeStem(path.posix.basename(rel));
    const startedAt = new Date().toISOString();
    const task = aeIterateTask({ instruction: req.instruction, scriptRel: rel, scriptText: beforeText, name });
    // The project is held from here: the agent's start is awaited, and no second flow may start meanwhile.
    this.starting.set(root, id);
    let s: Awaited<ReturnType<IterateDeps['startAgent']>>;
    try { s = await this.d.startAgent(req.agent, task, { paid: false, ...route.local, root, project, env }); } finally { this.starting.delete(root); }
    if (!s.ok) return this.refuse(`The agent did not start: ${scrub(s.error)}`, s.refused === 'paid' || s.refused === 'missing' ? 'estimate' : 'failure');
    const keptAt = keepBytes(root, `${flowWorkDir(id)}/script.before${path.posix.extname(rel).toLowerCase() || '.jsx'}`, bytes);
    const record: AeFlowRecord = {
      flow: 1, schema: FLOW_SCHEMA, id, kind: 'iterate', target: 'ae', instruction: req.instruction, project, started_at: startedAt, outcome: 'running',
      ...(req.comp !== undefined || req.om !== undefined ? { options: { ...(req.comp !== undefined ? { comp: req.comp } : {}), ...(req.om !== undefined ? { om: req.om } : {}) } } : {}),
      script: { path: rel, before: { sha256: sha(bytes), bytes: bytes.length, lines: lineCount(beforeText), ...(keptAt ? { kept: keptAt } : {}) } },
      agent: {
        run: s.run, agent: s.plan.agent, version: s.version, route: s.plan.charge, where: s.plan.where, model: s.plan.model, job: s.job.id,
        result: `${AGENTS_DIR}/${s.run}/result.json`, progress: `${AGENTS_DIR}/${s.run}/progress.log`,
      },
      receipts: {}, child_receipts: [], doctrine: DOCTRINE_15,
    };
    const flow: AeRun = { id, root, project, record, abort: new AbortController(), step: 'agent', beforeText, name, agentJob: s.job.id, agentRecord: s.record };
    // Before: an earlier /ae author run of these same bytes, judged ok (its comps are read when the flow ends).
    try { flow.before = previousAeAuthor(root, rel, record.script.before.sha256, startedAt); } catch (e) {
      flow.before = { none: `the runs from before could not be read (${scrub(e instanceof Error ? e.message : String(e))})` };
    }
    this.running.set(id, flow);
    this.saveState(flow);
    flow.done = this.run(flow).finally(() => { this.running.delete(id); });
    const g = this.d.glyphs;
    const where = (f: { how: string }): string => (f.how === 'env' ? 'set by its variable' : f.how === 'applications' ? 'in /Applications' : 'on PATH');
    const tools = this.tools(env);
    const prev = flow.before;
    return {
      ok: true, flow, lines: [
        [{ text: '  Flow       ', role: 'secondary' }, { text: id, role: 'strong' }, { text: `  iterate ae ${rel}: ${scrub(req.instruction)}`, role: 'secondary' }],
        [{ text: '  Script     ', role: 'secondary' }, { text: rel, role: 'strong' }, { text: `  ${record.script.before.lines} lines${this.sep}sha256 ${short(record.script.before.sha256)}${keptAt ? `${this.sep}kept as read: ${keptAt}` : ''}`, role: 'secondary' }],
        [{ text: '  Agent      ', role: 'secondary' }, { text: s.job.id, role: 'strong' }, { text: `  agent ${s.plan.agent} ${s.run}${this.sep}${s.info.title}${s.version ? ` ${s.version}` : ''}${s.plan.model ? `${this.sep}model ${s.plan.model} at ${s.plan.where}` : ''}${this.sep}${s.plan.charge}`, role: 'secondary' }],
        [{ text: '  Next       ', role: 'secondary' }, { text: `it may change only ${rel}; then After Effects (found, ${where(ae.found)}) runs it as /ae author --name ${name} does (its window opens), aerender (found, ${where(render.found)}) renders ${req.comp !== undefined ? `the comp ${req.comp}` : 'the first comp'} to out/ae/${name}-v<N>${AE_RENDER_EXT}${req.om !== undefined ? ` with the output module template "${req.om}" (After Effects' own name, not checked)` : ''}, ${tools.ready ? 'and the render is read back outside After Effects and compared with After Effects\' report' : `and the flow ends there: no readback (${tools.why})`}`, role: tools.ready ? 'secondary' : 'estimate' }],
        [{ text: '  Before     ', role: 'secondary' }, { text: 'none' in prev ? `${prev.none}: the flow's comp is reported alone` : `run ${prev.run.slice(0, 8)} (judged ok): its comps are set beside this run's, as After Effects reported each`, role: 'secondary' }],
        [{ text: '  Follow     ', role: 'secondary' }, { text: `/jobs ${s.job.id}${this.sep}/stop ${id} stops the flow${this.sep}/iterate lists flows${this.sep}the record: ${flowRecordPath(id)} ${g.arrow} /board`, role: 'secondary' }],
      ],
    };
  }

  // ── the steps ────────────────────────────────────────────────────────────────

  private async run(f: AeRun): Promise<AeFlowRecord> {
    try {
      await this.agentStep(f);
      if (f.record.outcome === 'running') this.checksStep(f);
      if (f.record.outcome === 'running') await this.authorStep(f);
      if (f.record.outcome === 'running') await this.renderStep(f);
      if (f.record.outcome === 'running') await this.readbackStep(f);
      if (f.record.outcome === 'running') this.end(f, 'failed', 'record', 'the flow ended without a verdict');
    } catch (e) {
      this.end(f, this.stopped(f) ? 'cancelled' : 'failed', f.step === 'done' ? 'record' : f.step, `the flow could not go on: ${this.d.scrub(e instanceof Error ? e.message : String(e), f.root)}`);
    }
    return this.finish(f);
  }

  private end(f: AeRun, outcome: Exclude<AeFlowRecord['outcome'], 'running'>, step: AeFlowStep, why: string): void {
    if (f.record.outcome !== 'running') return;
    f.record.outcome = outcome;
    f.record.ended_in = step;
    f.record.why = why;
  }

  private stopped(f: AeRun): boolean { return f.abort.signal.aborted; }

  private note(f: AeRun, text: string, role: Segment['role'] = 'secondary'): void {
    this.d.notify([{ text: `  ${this.d.glyphs.bullet} ` }, { text: f.id, role: 'strong' }, { text: `  ${text}`, role }]);
  }

  private saveState(f: AeRun): void {
    writeProjectJson(f.root, `${flowWorkDir(f.id)}/state.json`, { ...f.record, step: f.step });
  }

  /** A job's raw output (stdout and stderr as it logged them), copied into the flow's folder; its place, sha256 and size. */
  private keepLog(f: AeRun, job: JobRecord, name: string): { rel: string; sha256: string; bytes: number } | undefined {
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

  private async agentStep(f: AeRun): Promise<void> {
    const job = await this.d.jobs.done(f.agentJob!);
    // The agent's sealed result (sealAgent ran at the job's end): its outcome, what it changed, its cost and receipt.
    const rec = f.agentRecord!;
    const a = f.record.agent!;
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
    const keptOut = a.transcript ? `; its output is kept: ${a.transcript}` : '';
    if (this.stopped(f) || a.outcome === 'cancelled' || job.state === 'cancelled') return this.end(f, 'cancelled', 'agent', `stopped with /stop during the agent step; After Effects did not run${keptOut}`);
    if (a.outcome !== 'completed') return this.end(f, 'failed', 'agent', `the agent run ended ${a.outcome}${a.why ? `: ${a.why}` : ''}; After Effects did not run${keptOut}`);
    this.saveState(f);
  }

  private checksStep(f: AeRun): void {
    f.step = 'checks';
    const rel = f.record.script.path;
    const before = f.record.script.before;
    const a = f.record.agent!;
    const keptOut = a.transcript ? `; the agent's output is kept: ${a.transcript}` : '';
    const judged = judgeFileChanges(f.agentRecord?.files, rel);
    if (!judged.ok) {
      if (judged.others.length) a.others = judged.others;
      return this.end(f, 'stopped', 'checks', `${judged.why}; After Effects did not run, and nothing was reverted${keptOut}`);
    }
    // The agent's snapshot before it ran must have seen the bytes Timmy read (and gave it in its task).
    const seenBefore = judged.change?.previous_sha256;
    if (judged.params === 'changed' && seenBefore && seenBefore !== before.sha256) {
      return this.end(f, 'stopped', 'checks', `${rel} changed between Timmy's read and the agent's start (sha256 ${short(before.sha256)} read, ${short(seenBefore)} when the agent started); After Effects did not run`);
    }
    // The file as it is now, read here (not the agent's word): it must be what the agent's own snapshot saw.
    let bytes: Buffer;
    try { bytes = readFileSync(path.join(f.root, rel)); } catch { return this.end(f, 'stopped', 'checks', `${rel} cannot be read after the agent's run; After Effects did not run`); }
    const now = sha(bytes);
    const seen = judged.params === 'changed' ? judged.change?.sha256 ?? null : before.sha256;
    if (seen !== now) return this.end(f, 'stopped', 'checks', `${rel} changed after the agent's run ended (sha256 ${short(now)} now; the agent left ${seen ? short(seen) : 'an unhashed file'}); After Effects did not run`);
    if (judged.params === 'unchanged') return this.end(f, 'stopped', 'checks', 'the agent changed nothing; After Effects did not run');
    const afterText = bytes.toString('utf8');
    f.record.script.after = { sha256: now, bytes: bytes.length, lines: lineCount(afterText) };
    f.record.script.change = scriptChange(f.beforeText, afterText);
    // Compiled, never run: Node's vm.Script, a modern-JavaScript check of ExtendScript (ES3) source.
    const syntax = compileCheck(afterText, rel);
    f.record.script.syntax = syntax;
    if (syntax.checked && !syntax.ok) return this.end(f, 'stopped', 'checks', `${rel} as the agent left it ${compileWords(syntax)}; it is left as the agent wrote it; After Effects did not run${keptOut}`);
    this.note(f, `agent ${a.agent} ${a.run} completed: changed ${rel} (${changeText(f.record.script.change)})${this.sep}${compileWords(syntax)}`);
    this.saveState(f);
  }

  private async authorStep(f: AeRun): Promise<void> {
    f.step = 'author';
    if (this.stopped(f)) return this.end(f, 'cancelled', 'author', 'stopped with /stop before After Effects ran');
    const rel = f.record.script.path;
    const after = f.record.script.after!;
    const env = this.d.env();
    let spec: AeJobSpec;
    try {
      // /ae author's own job: the run's folder, the read-only copy of the script, the harness; judged by its result file.
      spec = aeScriptJob({ mode: 'author', script: rel, name: f.name, root: f.root, project: f.project, findEnv: env, env, label: `After Effects · author ${rel} · flow ${f.id}` });
    } catch (e) {
      const why = this.d.scrub(e instanceof NativeNotFound ? `${e.message}; ${e.setup}` : e instanceof Error ? e.message : String(e), f.root);
      f.record.author = { state: 'not started', error: why };
      return this.end(f, 'failed', 'author', `After Effects did not start: ${why}`);
    }
    const m = spec.native;
    const a: NonNullable<AeFlowRecord['author']> = {
      run: m.run, ...(m.record ? { record: relTo(m.root, m.record) } : {}), state: 'submitted', name: spec.ae.name, ...(spec.ae.version ? { version: spec.ae.version } : {}),
      ...(spec.ae.script ? { copy: { path: spec.ae.script.copyRel, sha256: spec.ae.script.sha256 } } : {}),
    };
    f.record.author = a;
    if (m.input?.sha256 !== after.sha256) {
      a.state = 'not started';
      return this.end(f, 'stopped', 'author', `${rel} changed after it was checked (sha256 ${short(m.input?.sha256)} when submitted, ${short(after.sha256)} checked); After Effects did not run`);
    }
    let job: JobRecord;
    try { job = this.d.startNative!(spec); } catch (e) {
      a.state = 'not started';
      a.error = this.d.scrub(e instanceof Error ? e.message : String(e), f.root);
      return this.end(f, 'failed', 'author', `After Effects did not start: ${a.error}`);
    }
    f.authorJob = job.id;
    a.job = job.id;
    a.state = 'running';
    this.note(f, `After Effects: ${job.id} runs ${rel} as submitted (its copy: ${a.copy?.path ?? 'none'}) in a new project, saved as ${spec.ae.saved?.rel}${this.sep}its window opens${this.sep}judged by its result file${this.sep}/jobs ${job.id}`);
    this.saveState(f);
    if (this.stopped(f)) await this.d.jobs.stop(job.id);
    const done = await this.d.jobs.done(job.id);
    a.state = done.state;
    if (done.receipt) { a.receipt = done.receipt; f.record.receipts.author = done.receipt; }
    const log = this.keepLog(f, done, 'author.log');
    if (log) a.log = log.rel;
    if (this.stopped(f) || done.state === 'cancelled') {
      const when = done.state === 'cancelled' ? `during the After Effects run (job ${job.id}; After Effects itself may still be running the script)` : `as the After Effects run ended (job ${job.id} ${done.state}; its own receipt judges it)`;
      return this.end(f, 'cancelled', 'author', `stopped with /stop ${when}; whatever it wrote is kept, and nothing was rendered${a.log ? `; its output: ${a.log}` : ''}`);
    }
    // The run judged as /ae author judges it: by its result file, the new version created by this run, the harness unchanged.
    const j = judgeAeJob(done, spec);
    a.outcome = j.outcome;
    a.why = this.d.scrub(j.why, f.root);
    if (j.ae.ae_version) a.ae_version = j.ae.ae_version;
    if (m.result) { const r = sha256File(m.result); a.result = { path: relTo(m.root, m.result), ...(r ? { sha256: r } : {}) }; }
    if (j.ae.comps) a.comps = j.ae.comps.slice(0, 20).map((c) => ({ name: c.name, width: c.width, height: c.height, fps: c.fps, duration: c.duration, layers: Array.isArray(c.layers) ? c.layers.length : 0 }));
    if (j.ae.error) { a.error = this.d.scrub(j.ae.error, f.root); if (j.ae.stage) a.stage = j.ae.stage; if (j.ae.error_line !== undefined) a.error_line = j.ae.error_line; }
    const saved = j.ae.saved;
    if (j.outcome !== 'ok' || !saved?.present || !saved.created || !saved.sha256) {
      a.failure_files = kept(f.root, [...(a.result ? [a.result.path] : []), ...(m.record ? [`${relTo(m.root, m.record)}/verdicts.jsonl`] : []), ...(a.log ? [a.log] : []), ...(saved?.present ? [saved.path] : [])]);
      return this.end(f, 'failed', 'author', `After Effects' run is judged ${j.outcome}, not ok: ${a.why}; nothing was rendered${a.failure_files.length ? `; kept: ${a.failure_files.join(', ')}` : ''}`);
    }
    a.aep = { path: saved.path, sha256: saved.sha256, bytes: saved.bytes ?? 0 };
    // The comp to render: --comp's, else the first After Effects reported.
    const chosen = chooseComp(j.ae.comps, f.record.options?.comp);
    if (!chosen.ok) return this.end(f, 'failed', 'render', `${chosen.why}; nothing was rendered; After Effects' run is judged ok and its project is ${saved.path}`);
    f.comp = chosen.comp;
    this.saveState(f);
  }

  private async renderStep(f: AeRun): Promise<void> {
    f.step = 'render';
    const a = f.record.author!;
    const aep = a.aep!;
    const comp = f.comp!;
    const compName = comp.name ?? '';
    const requested = aep.path.replace(/\.aepx?$/i, AE_RENDER_EXT);
    const r: NonNullable<AeFlowRecord['render']> = { state: 'not started', comp: compName, requested, ...(f.record.options?.om !== undefined ? { om_template: f.record.options.om } : {}) };
    f.record.render = r;
    if (this.stopped(f)) return this.end(f, 'cancelled', 'render', `stopped with /stop before aerender ran; After Effects' project is ${aep.path}`);
    const env = this.d.env();
    const found = locateNative('aerender', env);
    if (!found.found) {
      r.error = `${NATIVE_APPS.aerender.name} was not found on this machine${found.problem ? ` (${found.problem})` : ''}; ${NATIVE_APPS.aerender.setup}`;
      return this.end(f, 'failed', 'render', `aerender did not start: ${r.error}`);
    }
    let spec: NativeJobSpec;
    try {
      spec = aerenderJob({
        projectFile: aep.path, comp: compName, output: requested, root: f.root, project: f.project, bin: found.found.path, env,
        ...(r.om_template !== undefined ? { omTemplate: r.om_template } : {}), label: `After Effects render · ${aep.path} › ${compName} · flow ${f.id}`,
      });
    } catch (e) {
      r.error = this.d.scrub(e instanceof Error ? e.message : String(e), f.root);
      return this.end(f, 'failed', 'render', `aerender did not start: ${r.error}`);
    }
    const m = spec.native;
    r.run = m.run;
    if (m.record) r.record = relTo(m.root, m.record);
    r.state = 'submitted';
    if (m.input?.sha256 !== aep.sha256) {
      r.state = 'not started';
      return this.end(f, 'stopped', 'render', `${aep.path} changed after After Effects' run was judged (sha256 ${short(m.input?.sha256)} when submitted, ${short(aep.sha256)} judged); aerender did not run`);
    }
    let job: JobRecord;
    try { job = this.d.startNative!(spec); } catch (e) {
      r.state = 'not started';
      r.error = this.d.scrub(e instanceof Error ? e.message : String(e), f.root);
      return this.end(f, 'failed', 'render', `aerender did not start: ${r.error}`);
    }
    f.renderJob = job.id;
    r.job = job.id;
    r.state = 'running';
    this.note(f, `aerender: ${job.id} renders ${compName} from ${aep.path} to ${requested}${r.om_template !== undefined ? ` with the output module template "${r.om_template}"` : ''}${this.sep}its output module decides the container${this.sep}/jobs ${job.id}`);
    this.saveState(f);
    if (this.stopped(f)) await this.d.jobs.stop(job.id);
    const done = await this.d.jobs.done(job.id);
    r.state = done.state;
    if (done.receipt) { r.receipt = done.receipt; f.record.receipts.render = done.receipt; }
    const log = this.keepLog(f, done, 'render.log');
    if (log) r.log = log.rel;
    if (this.stopped(f) || done.state === 'cancelled') {
      const when = done.state === 'cancelled' ? `during the render (job ${job.id})` : `as the render ended (job ${job.id} ${done.state}; its own receipt judges it)`;
      return this.end(f, 'cancelled', 'render', `stopped with /stop ${when}; whatever it wrote is kept, and nothing was read back${r.log ? `; its output: ${r.log}` : ''}`);
    }
    // Judged as /ae's render is: the file asked for, or the one file of its name with another extension this run made.
    const j = judgeNativeJob(done, spec);
    r.outcome = j.outcome;
    r.why = this.d.scrub(j.why, f.root);
    const file = j.instead?.written ?? requested;
    const check = j.files.find((x) => x.path === file);
    if (j.outcome !== 'ok' || !check?.sha256) {
      r.failure_files = kept(f.root, [...(m.record ? [`${relTo(m.root, m.record)}/verdicts.jsonl`] : []), ...(r.log ? [r.log] : []), ...(j.instead?.candidates ?? []), ...(check?.present ? [file] : [])]);
      return this.end(f, 'failed', 'render', `aerender's run is judged ${j.outcome}, not ok: ${r.why}; nothing was read back${r.failure_files.length ? `; kept: ${r.failure_files.join(', ')}` : ''}`);
    }
    let bytes: number | undefined;
    try { bytes = statSync(path.join(f.root, file)).size; } catch { bytes = undefined; }
    r.file = { path: file, sha256: check.sha256, ...(bytes !== undefined ? { bytes } : {}), instead: !!j.instead?.written };
    this.saveState(f);
  }

  private async readbackStep(f: AeRun): Promise<void> {
    f.step = 'readback';
    const render = f.record.render!;
    const file = render.file!;
    const rb: NonNullable<AeFlowRecord['readback']> = { state: 'not started', label: AE_READBACK_LABEL, reported_by: AE_REPORTED_BY };
    f.record.readback = rb;
    const env = this.d.env();
    const tools = this.tools(env);
    if (!tools.ready) {
      rb.state = 'not run';
      rb.setup = `${tools.why}: ${AE_FFMPEG_SETUP}`;
      return this.end(f, 'succeeded', 'readback', `succeeded without readback: After Effects' run and aerender's render (${file.path}) are judged ok, but no readback could run (${tools.why}); the render is not compared with After Effects' report. Setup: ${AE_FFMPEG_SETUP}`);
    }
    if (this.stopped(f)) { rb.state = 'cancelled'; return this.end(f, 'cancelled', 'readback', `stopped with /stop before the readback started; the render ${file.path} is kept`); }
    const planned = planReadback(f.comp!);
    if ('error' in planned) {
      rb.verdict = 'failed';
      rb.reason = planned.error;
      return this.end(f, 'failed', 'readback', `the readback did not start: ${planned.error}`);
    }
    const plan: AeReadbackPlan = planned;
    const work = flowWorkDir(f.id);
    const p = writeProjectJson(f.root, `${work}/readback-plan.json`, plan.file);
    if (!p.ok) {
      rb.verdict = 'failed';
      rb.reason = `its plan could not be written: ${this.d.scrub(p.error, f.root)}`;
      return this.end(f, 'failed', 'readback', `the readback did not start: ${rb.reason}`);
    }
    rb.plan = { path: p.path, sha256: p.sha256 };
    const abs = path.join(f.root, ...file.path.split('/'));
    // Timmy's own sha256 of the render, before the read: it must be the bytes the judged run recorded.
    const before = sha256File(abs);
    if (!before || before !== file.sha256) {
      rb.verdict = 'failed';
      rb.reason = `${file.path} ${before ? `changed after aerender's run was judged (sha256 ${short(before)} now, ${short(file.sha256)} then)` : 'is gone, or cannot be read'}`;
      return this.end(f, 'failed', 'readback', `${rb.reason}; nothing was read back`);
    }
    rb.video = { path: file.path, sha256: before };
    const frames = `${work}/frames`;
    let job: JobRecord;
    try {
      job = this.d.startJob({
        kind: 'task', label: `readback ${file.path} · flow ${f.id}`, project: f.project, root: f.root,
        command: tools.python, args: ['-I', VIDEO_READBACK_SCRIPT, abs, '--plan', path.join(f.root, ...p.path.split('/')), '--frames-dir', path.join(f.root, ...frames.split('/')), '--as', file.path],
        env: { ...env, TIMMY_FFPROBE: tools.ffprobe, TIMMY_FFMPEG: tools.ffmpeg }, timeoutMs: VIDEO_READBACK_TIMEOUT_MS,
      }, { selfSealed: true });
    } catch (e) {
      rb.verdict = 'failed';
      rb.reason = this.d.scrub(e instanceof Error ? e.message : String(e), f.root);
      return this.end(f, 'failed', 'readback', `the readback did not start: ${rb.reason}`);
    }
    f.readbackJob = job.id;
    rb.job = job.id;
    rb.state = 'running';
    const layers = plan.layers.map((l) => l.name);
    this.note(f, `readback: ${job.id} reads ${file.path} outside After Effects (ffprobe, ffmpeg and Timmy's pixel reading)${layers.length ? `: ${layers.join(', ')} at ${plan.layers.reduce((n, l) => n + l.times.length, 0)} times` : ': the comp\'s facts only'}${this.sep}/jobs ${job.id}`);
    this.saveState(f);
    if (this.stopped(f)) await this.d.jobs.stop(job.id);
    const done = await this.d.jobs.done(job.id);
    const log = this.keepLog(f, done, 'readback.log');
    if (log) rb.log = log.rel;
    rb.state = done.state;
    const finish = (verdict: 'matches' | 'differs' | 'failed' | undefined, outcome: Exclude<AeFlowRecord['outcome'], 'running'>, why: string): void => {
      if (verdict) rb.verdict = verdict;
      const receipt = this.sealReadback(f, done, log);
      if (receipt) { rb.receipt = receipt; f.record.receipts.readback = receipt; }
      this.end(f, outcome, 'readback', why);
    };
    if (this.stopped(f) || done.state === 'cancelled') {
      rb.state = 'cancelled';
      rb.reason = 'stopped with /stop before it finished: no verdict';
      return finish(undefined, 'cancelled', `stopped with /stop during the readback; the render ${file.path} is kept; no verdict${rb.log ? `; its output so far: ${rb.log}` : ''}`);
    }
    let size = 0;
    try { size = statSync(done.logPath).size; } catch { size = 0; }
    const parsed: VideoReadback | VideoReadbackFailure = size > VIDEO_READBACK_MAX_OUTPUT
      ? { ok: false, code: 'too-much-output', error: `the worker printed more than ${VIDEO_READBACK_MAX_OUTPUT} bytes` }
      : parseVideoReadback(this.d.jobs.tail(done.id, 400).join('\n'));
    if (parsed.worker) rb.worker = parsed.worker;
    const keptOut = rb.log ? `; its output is kept: ${rb.log}` : '';
    if (!parsed.ok) {
      rb.reason = this.d.scrub(`${parsed.code}: ${parsed.error}`, f.root);
      return finish('failed', 'failed', `the readback failed: ${rb.reason}${done.state !== 'completed' ? ` (${exitWords(done)})` : ''}${keptOut}`);
    }
    if (done.state !== 'completed') {
      rb.reason = `the worker reported values but ${exitWords(done)}`;
      return finish('failed', 'failed', `the readback failed: ${rb.reason}${keptOut}`);
    }
    rb.tools = parsed.tools;
    rb.probe = parsed.probe;
    rb.scale = parsed.scale;
    rb.scaled = parsed.scaled;
    if (parsed.source.sha256 !== file.sha256) {
      rb.reason = `the worker read bytes other than the render (sha256 ${short(parsed.source.sha256)}, rendered ${short(file.sha256)})`;
      return finish('failed', 'failed', `the readback failed: ${rb.reason}`);
    }
    if (!parsed.unchanged_during_read || sha256File(abs) !== file.sha256) {
      rb.reason = `${file.path} changed while it was read back`;
      return finish('failed', 'failed', `the readback failed: ${rb.reason}`);
    }
    // Each frame's picture the worker kept, by the sha256 Timmy reads now (a picture that differs is left out, and said).
    const pictures: NonNullable<typeof rb.frames> = [];
    for (const x of parsed.frames) {
      if (!x.png || x.written !== true || !x.sha256) continue;
      const rel = `${frames}/${x.png}`;
      if (sha256File(path.join(f.root, ...rel.split('/'))) === x.sha256) pictures.push({ path: rel, frame: x.frame, time: x.time, sha256: x.sha256 });
    }
    rb.frames = pictures;
    const cmp = compareAeReadback(plan, parsed);
    rb.tolerance = cmp.tolerance;
    rb.checks = cmp.checks;
    rb.not_compared = cmp.not_compared;
    const positions = cmp.checks.filter((c) => c.name.includes(' at ') && c.passed !== null);
    const facts = `${parsed.probe.width}x${parsed.probe.height}, ${n3(parsed.probe.fps_value)} fps, ${n3(parsed.probe.duration)} s, ${parsed.probe.frames ?? '?'} frames`;
    const posWords = positions.length
      ? `, and ${positions.length} position${positions.length === 1 ? '' : 's'} of ${[...new Set(positions.map((c) => c.name.replace(/ at [^ ]+ s$/, '')))].join(', ')} within ${cmp.tolerance.x_px} x ${cmp.tolerance.y_px} comp pixels`
      : `; no layer's position was compared${cmp.not_compared.length ? ` (${cmp.not_compared.slice(0, 3).join('; ')})` : ' (no solid with Position keyframes and a reported colour)'}`;
    if (cmp.verdict === 'matches') return finish('matches', 'succeeded', `the render ${file.path} matches After Effects' own report: ${facts}${posWords}; ${AE_READBACK_LABEL}`);
    return finish('differs', 'differs', `the render ${file.path} differs from After Effects' own report: ${differencesText(cmp.checks)}; ${AE_READBACK_LABEL}`);
  }

  /** The readback's receipt (kind readback): what it read (in sources: it changed nothing it read), its job, its frames, its verdict. */
  private sealReadback(f: AeRun, job: JobRecord, log?: { rel: string; sha256: string; bytes: number }): string | undefined {
    const r = f.record.readback!;
    const ms = job.endedAt ? Date.parse(job.endedAt) - Date.parse(job.startedAt) : undefined;
    const failing = (r.checks ?? []).filter((c) => c.passed === false).map((c) => `${c.name}: reported ${JSON.stringify(c.reported)}, measured ${JSON.stringify(c.measured)}`);
    const size = (rel: string): number => { try { return statSync(path.join(f.root, ...rel.split('/'))).size; } catch { return 0; } };
    try {
      return this.d.seal({
        kind: 'readback', subject: `readback · ${r.video?.path ?? 'render'} · ${r.verdict ?? r.state}`, policy: 'human-gated',
        status: r.verdict === 'matches' ? 'ok' : r.state === 'cancelled' ? 'cancelled' : 'failed',
        project: f.project, project_id: projectId(f.root),
        job: { id: job.id, kind: job.kind, label: this.d.scrub(job.label, f.root), state: job.state, exit_code: job.exitCode ?? null, ...(ms !== undefined ? { ms } : {}), ...(job.error ? { error: this.d.scrub(job.error, f.root) } : {}) },
        outputs: [...(log ? [{ path: log.rel, sha256: log.sha256, bytes: log.bytes }] : []), ...(r.frames ?? []).map((x) => ({ path: x.path, sha256: x.sha256, bytes: size(x.path) }))].filter((o) => o.path),
        sources: [
          ...(r.video ? [{ path: r.video.path, sha256: r.video.sha256, role: 'read' }] : []),
          ...(r.plan ? [{ path: r.plan.path, sha256: r.plan.sha256, role: 'the plan: the layers and times read' }] : []),
          {
            flow: f.id, worker: r.worker ? `${r.worker.name} ${r.worker.version}` : null, ffprobe: r.tools?.ffprobe?.version ?? null, ffmpeg: r.tools?.ffmpeg?.version ?? null,
            probe: r.probe ?? null, scale: r.scale ?? null, tolerance: r.tolerance ?? null, verdict: r.verdict ?? null, label: AE_READBACK_LABEL, reported_by: AE_REPORTED_BY,
            checks: (r.checks ?? []).map((c) => ({ name: c.name, passed: c.passed })),
          },
        ],
        ...(f.record.receipts.render ? { child_receipts: [f.record.receipts.render] } : {}),
        ...(failing.length ? { discrepancies: failing } : r.reason ? { discrepancies: [r.reason] } : {}),
      });
    } catch { return undefined; }
  }

  /** The record (results/flows/<flow-id>.json), the flow receipt binding its sha256 and the child receipts, the notice. */
  private finish(f: AeRun): AeFlowRecord {
    f.step = 'record';
    const rec = f.record;
    rec.ended_at = new Date().toISOString();
    // Before and after: the comp as After Effects reported it in an earlier judged-ok run of the script as it was, and in this run.
    if (f.comp && rec.author?.run) {
      const after = { ...compFacts(f.comp), run: rec.author.run, ...(rec.author.job ? { job: rec.author.job } : {}) };
      const prev = f.before;
      const old = prev && !('none' in prev) ? chooseComp(reportedComps(f.root, prev.run), f.comp.name ?? undefined) : undefined;
      const beforeFacts = old?.ok ? { ...compFacts(old.comp), run: (prev as { run: string }).run, ...((prev as { job?: string }).job ? { job: (prev as { job?: string }).job } : {}), started_at: (prev as { started_at: string }).started_at } : null;
      rec.before_after = {
        reported_by: AE_REPORTED_BY, before: beforeFacts,
        ...(beforeFacts ? {} : { before_note: prev && 'none' in prev ? prev.none : old && !old.ok ? `the earlier run's report has no comp ${f.comp.name ?? ''}: ${old.why}` : 'no earlier run' }),
        after, ...(beforeFacts ? { changes: factsChanges(beforeFacts, after) } : {}),
      };
    }
    const r = rec.receipts;
    rec.child_receipts = [r.agent, r.author, r.render, r.readback].filter((x): x is string => typeof x === 'string');
    const w = writeProjectJson(f.root, flowRecordPath(f.id), rec);
    const status = rec.outcome === 'succeeded' ? 'ok' as const : rec.outcome === 'cancelled' ? 'cancelled' as const : 'failed' as const;
    const cost = rec.agent?.cost_usd;
    let receipt: string | undefined;
    try {
      receipt = this.d.seal({
        kind: 'flow', subject: `flow · iterate · ae · ${f.id} · ${rec.outcome}`, policy: 'human-gated', status,
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

  private endLines(f: AeRun, file: string | undefined, receipt: string | undefined): Line[] {
    const g = this.d.glyphs;
    const rec = f.record;
    const ok = rec.outcome === 'succeeded';
    const tail = `${file ? `${this.sep}record ${file}` : `${this.sep}the record could not be written`}${receipt ? `${this.sep}receipt ${receipt}` : ''}`;
    const lines: Line[] = [[{ text: `  ${ok ? g.ok : rec.outcome === 'cancelled' ? ' ' : g.fail} `, role: ok || rec.outcome === 'cancelled' ? undefined : 'failure' },
      { text: `${f.id} ${rec.outcome}`, role: ok || rec.outcome === 'cancelled' ? 'strong' : 'failure' }, { text: `: ${rec.why ?? ''}${tail}`, role: 'secondary' }]];
    if (f.comp) lines.push([{ text: '      After Effects reported: ', role: 'secondary' }, { text: this.d.scrub(aeCompsLine([f.comp]).replace(/^1 comp: /, ''), f.root), role: 'strong' }, { text: `${this.sep}${AE_REPORTED_BY}`, role: 'secondary' }]);
    const ba = rec.before_after;
    if (ba?.changes) lines.push([{ text: `      before ${g.arrow} after: `, role: 'secondary' }, { text: ba.changes.length ? ba.changes.slice(0, 6).join('; ') : 'no change in what After Effects reported', role: 'strong' }, { text: `${this.sep}run ${ba.before?.run.slice(0, 8)} ${g.arrow} run ${ba.after?.run.slice(0, 8)}, as After Effects reported each`, role: 'secondary' }]);
    else if (ba?.before_note) lines.push([{ text: `      before ${g.arrow} after: `, role: 'secondary' }, { text: `${ba.before_note}: this run's comp alone`, role: 'secondary' }]);
    const k = rec.readback;
    if (k?.probe && k.verdict && k.verdict !== 'failed') {
      const p = k.probe;
      lines.push([{ text: '      the render, read back: ', role: 'secondary' }, { text: `${p.width}x${p.height}, ${n3(p.fps_value)} fps, ${n3(p.duration)} s, ${p.frames ?? '?'} frames${p.codec ? `, ${p.codec}` : ''}`, role: 'strong' },
        { text: `${this.sep}${k.verdict}${k.tolerance ? `${this.sep}positions within ${k.tolerance.x_px} x ${k.tolerance.y_px} comp pixels (${k.tolerance.rule})` : ''}`, role: 'secondary' }]);
      lines.push([{ text: `      ${AE_READBACK_LABEL}`, role: 'secondary' }]);
      if (k.frames?.length) lines.push([{ text: '      frames: ', role: 'secondary' }, { text: k.frames.slice(0, 6).map((x) => x.path).join(', '), role: 'secondary' }]);
    }
    return lines;
  }

  // ── stopping ─────────────────────────────────────────────────────────────────

  /** `/stop <flow-id>` for an After Effects flow: stops the step that runs, waits for the record, and says what happened. */
  async stop(id: string): Promise<Line[]> {
    const f = this.running.get(id);
    if (!f) return this.say(`No flow ${id} is running in this REPL: /iterate lists the flows.`);
    const step = f.step;
    f.abort.abort();
    if (step === 'agent' && f.agentJob) await this.d.jobs.stop(f.agentJob);
    else if (step === 'author' && f.authorJob) await this.d.jobs.stop(f.authorJob);
    else if (step === 'render' && f.renderJob) await this.d.jobs.stop(f.renderJob);
    else if (step === 'readback' && f.readbackJob) await this.d.jobs.stop(f.readbackJob);
    const rec = f.done ? await within(f.done, 60_000) : undefined;
    if (!rec) return this.say(`${id}: stopping (it was in the ${step} step); its record is not written yet: /iterate`, 'estimate');
    return [[{ text: `  ${id} ${rec.outcome}`, role: rec.outcome === 'cancelled' ? 'strong' : 'failure' },
      { text: `  ${rec.why ?? ''}${f.recordFile ? `${this.sep}record ${f.recordFile}` : ''}${f.receipt ? `${this.sep}receipt ${f.receipt}` : ''}`, role: 'secondary' }]];
  }

  /**
   * /stop all and the REPL's end: every After Effects flow is marked stopped, so none starts a next step (the jobs
   * themselves are stopped by the caller, as this REPL's jobs). How many were running, their records to wait for, and how
   * each ended.
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

  /** The records of the After Effects flows running now, to wait for. */
  pending(): Array<Promise<unknown>> { return [...this.running.values()].map((f) => f.done ?? Promise.resolve()); }
}
