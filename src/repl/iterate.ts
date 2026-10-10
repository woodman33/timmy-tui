/**
 * /iterate in the REPL (round R4, helper H24): the connected workflow, one flow with its own id (f + 8 hex):
 *
 *   1. the recipe's parameter file (recipes/tray.params.json) is read and checked, or written from the recipe
 *      card's defaults (and the operator is told); its sha256 and values are kept;
 *   2. a local code agent runs through /agent's own start (Workspace.startAgentRun: the endpoint rule, the
 *      snapshot before and after, its job, its sealed result), told to change only that file. Only a local,
 *      free route runs: Qwen Code on a loopback endpoint with a model that is not a cloud model, or (round R4,
 *      H25, --agent codex) Codex's local route under the same rule (codex exec --oss); nothing else;
 *   3. after it: any other file changed stops the flow before the build (nothing is reverted); an invalid
 *      parameter file stops it (the file is left as the agent wrote it); no change stops it;
 *   4. the recipe rebuilds through /recipe's start (startRecipeJob: the prediction sealed first, the durable
 *      job and its watcher), followed as Timmy jobs;
 *   5. a separate worker (workers/readback/step_readback.py, run with TIMMY_CADQUERY_PYTHON as its own job)
 *      reads the delivered STEP back, and what it measured is compared with the sealed prediction;
 *   6. the flow record (results/flows/<flow-id>.json) and a `flow` receipt binding its sha256 and the child
 *      receipts. Every step's raw failure stays where it was written and the record names it.
 *
 * /stop <flow-id> stops the step that runs: the agent's job; during the build, the recipe's own cancel
 * (lanes/recipes/jobs.ts cancel) first, then the watcher; the readback's job. /stop all and the REPL's end
 * stop every flow so none starts a next step. A flow's steps are this REPL's jobs, so /stop <job> on one of
 * them ends the flow too. DOCTRINE §15: the readback measures the CAD file, never a physical part.
 *
 * Round R4 (H33): `/iterate scad <model.scad> "<instruction>"` and `/iterate freecad <script.py> "<instruction>"` are
 * parsed here and run by src/repl/iterate-scad.ts and src/repl/iterate-freecad.ts (their shared steps in
 * src/repl/iterate-native.ts); `--agent codex`, Codex's local route, is taken by every target, blender included.
 *
 * Round R4 review (R4-5): every start, of any kind and from /iterate or the agent's tools, holds its project
 * (src/repl/flow-lock.ts) from before its first await until it ends, so a second start in that project meanwhile is
 * refused, as a start is while a flow runs there.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { JobManager, JobRecord, JobSpec } from '../jobs/index.js';
import { AGENTS, AGENTS_DIR, AGENT_NAMES, agentBin, planAgent, type AgentInfo, type AgentName, type AgentPlan, type AgentRunRecord } from '../code-agents/index.js';
import { codexLocalPreflight } from '../code-agents/codex-local.js';
import { checkCopy, failureFiles, nativeRuntime, PARAMETER_HELP, PARAMETER_NAMES, PYTHON_SETUP, readCard, RECIPE_ID, short } from '../recipes/index.js';
import { paramsPath, parseParams, readParams, writeParams } from '../recipes/params-file.js';
import { cancel, status } from '../../lanes/recipes/jobs.js';
import { projectId } from '../project/index.js';
import { splitCommandLine } from '../connectors/mcp-cli.js';
import {
  compareReadback, diffText, DOCTRINE_15, FLOW_ID, FLOW_SCHEMA, flowRecordPath, flowWorkDir, iterateTask, judgeAgentChanges, listFlows, mm3Text, mmText,
  newFlowId, paramDiff, parseReadbackOutput, READBACK_MAX_OUTPUT, READBACK_SCOPE, READBACK_SCRIPT, READBACK_TIMEOUT_MS, READBACK_TOLERANCE, STEP_EXPORT, toleranceText,
  writeFlowRecord, writeProjectJson, type FlowOutcome, type FlowRecord, type FlowStep, type ReadbackFailure, type ReadbackMeasured,
} from '../flows/iterate.js';
import type { RecipeStarted } from './recipe.js';
// R4 (H26): /iterate blender <script.py> "<instruction>", run by src/repl/iterate-blender.ts.
import { BLENDER_USAGE, BlenderFlows, type BlenderIterateRequest } from './iterate-blender.js';
import { blenderFlowSummary } from '../flows/iterate-blender.js';
// R4 (H33): /iterate scad and /iterate freecad (src/repl/iterate-scad.ts, src/repl/iterate-freecad.ts).
import { ScadFlows, SCAD_ITERATE_USAGE } from './iterate-scad.js';
import { FreecadFlows, FREECAD_ITERATE_USAGE } from './iterate-freecad.js';
import type { NativeIterateRequest } from './iterate-native.js';
import { isScadFlowRecord, scadFlowSummary } from '../flows/iterate-scad.js';
import { freecadFlowSummary, type FreecadFlowRecord } from '../flows/iterate-freecad.js';
import type { FreecadReadbackLine, FreecadReadbackPlan } from '../native/freecad.js';
import type { NativeJobSpec } from '../native/index.js';
import type { GlyphSet } from '../term/glyphs.js';
import type { Segment } from '../term/theme.js';
import type { ReceiptInput } from '../utils/receipts.js';
import { FlowLock, type FlowKind } from './flow-lock.js';

type Line = Segment[];
/** A start refused before anything was written. */
type Refused = { ok: false; error: string; lines: Line[] };

/** A code agent's run started through /agent's own start, as data (Workspace.startAgentRun); /agent prints it. */
export type AgentStart =
  | { ok: true; job: JobRecord; run: string; plan: AgentPlan; info: AgentInfo; version: string | null; record: AgentRunRecord }
  | { ok: false; refused: 'missing' | 'setup' | 'paid' | 'usage' | 'prepare'; error: string };

/** Test seams only (labelled where used). */
export interface IterateTestSeams {
  /** A FAKE readback worker: the command run instead of TIMMY_CADQUERY_PYTHON workers/readback/step_readback.py. */
  readback?: (step: { abs: string; rel: string }) => { command: string; args: string[] };
  /** How long a stopped build waits for the recipe's final state (default 15 s). */
  settleMs?: number;
}

export interface IterateDeps {
  glyphs: GlyphSet;
  /** The REPL's environment, read at each start. */
  env: () => NodeJS.ProcessEnv;
  onPath: (cmd: string) => string | null;
  notify: (line: Line) => void;
  /** Seals a receipt on the runs chain; its short id back, or undefined when sealing failed. */
  seal: (input: ReceiptInput) => string | undefined;
  jobs: JobManager;
  /** Starts a job as this REPL's own (so /stop and /stop all reach it); `selfSealed`: the flow seals its receipt. */
  startJob: (spec: JobSpec, o?: { selfSealed?: boolean }) => JobRecord;
  /** /agent's own start, in the flow's project; `local`: Codex's local route (round R4, H25). */
  startAgent: (name: AgentName, task: string, o: { paid: false; local?: true; root: string; project: string; env: NodeJS.ProcessEnv }) => Promise<AgentStart>;
  /** /recipe's own start (startRecipeJob), in the flow's project. */
  startRecipe: (root: string, project: string, given: Record<string, unknown>) => Promise<RecipeStarted>;
  /** Writes the project's folder as "." and the home folder as "~". */
  scrub: (text: string, root: string) => string;
  /** R4 (H26): starts a native job as this REPL's own, judged and sealed at its end as /blender's are. */
  startNative?: (spec: NativeJobSpec) => JobRecord;
  /**
   * R4 (H33): /freecad readback's own runner (src/repl/freecad.ts FreecadReadbacks), for /iterate freecad: whether a
   * readback could run now (said, not checked by running anything), and the readback of a planned STEP as its own job.
   */
  freecadReadback?: {
    ready: () => { ready: boolean; why?: string };
    run: (plan: FreecadReadbackPlan, at: { root: string; project: string }, o?: { label?: string }) =>
      { ok: true; job: JobRecord; done: Promise<FreecadReadbackLine | undefined> } | { ok: false; failed?: true; error: string };
  };
  test?: IterateTestSeams;
}

export interface IterateRequest { recipe: 'tray'; instruction: string; agent: AgentName; model?: string }

const USAGE = '/iterate tray "<instruction>" [--agent qwen|codex] [--model <local model>]';
/** The agents /iterate runs, each on its local, free route (round R4: codex is Codex's local route, H25). */
const LOCAL_AGENTS: readonly AgentName[] = ['qwen', 'codex'];

/**
 * `/iterate tray "<instruction>" [--agent qwen|codex] [--model <m>]`, (R4, H26) `/iterate blender <script.py> "<instruction>"`,
 * or (R4, H33) `/iterate scad <model.scad> "<instruction>"` and `/iterate freecad <script.py> "<instruction>"`, each with
 * [--agent qwen|codex] [--model <m>]: the request, or why it is refused (nothing started).
 */
export function parseIterateLine(args: string): { ok: true; request: IterateRequest | BlenderIterateRequest | NativeIterateRequest } | { ok: false; error: string } {
  const words = splitCommandLine(args.trim());
  const [what, ...rest] = words;
  if (!what) return { ok: false, error: `Usage: ${USAGE}` };
  // R4 (H26): a Blender script's flow names its script first; (H33) an OpenSCAD flow its model, a FreeCAD flow its script.
  let script: string | undefined;
  let file: string | undefined;
  const fileUsage = what === 'scad' ? SCAD_ITERATE_USAGE : FREECAD_ITERATE_USAGE;
  if (what === 'blender') {
    script = rest.shift();
    if (!script || script.startsWith('--')) return { ok: false, error: `Name the script: ${BLENDER_USAGE}` };
  } else if (what === 'scad' || what === 'freecad') {
    file = rest.shift();
    if (!file || file.startsWith('--')) return { ok: false, error: `Name the ${what === 'scad' ? 'model' : 'script'}: ${fileUsage}` };
  } else if (what !== 'tray' && what !== RECIPE_ID) return { ok: false, error: `No recipe ${what}: /iterate takes tray (${RECIPE_ID}), scad <model.scad>, freecad <script.py> or blender <script.py>. Usage: ${USAGE}` };
  let agent: string | undefined;
  let model: string | undefined;
  const text: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i];
    const eq = w.match(/^(--agent|--model)=(.*)$/);
    if (w === '--paid') return { ok: false, error: '/iterate runs only a local, free agent route (Qwen Code, or Codex with a local model, on this machine\'s endpoint); it has no --paid. Nothing was started.' };
    if (eq) { if (eq[1] === '--agent') agent = eq[2]; else model = eq[2]; continue; }
    if (w === '--agent' || w === '--model') {
      const v = rest[i + 1];
      if (v === undefined || v.startsWith('--')) return { ok: false, error: `${w} needs a value. Usage: ${USAGE}` };
      if (w === '--agent') agent = v; else model = v;
      i += 1;
      continue;
    }
    if (/^--\S/.test(w)) return { ok: false, error: `No option ${w}: /iterate takes --agent qwen|codex and --model <local model>. Nothing was started.` };
    text.push(w);
  }
  const instruction = text.join(' ').trim();
  if (!instruction) return { ok: false, error: `Say what to change: ${script ? BLENDER_USAGE : file ? fileUsage : USAGE}` };
  const name = (agent ?? 'qwen').toLowerCase() as AgentName;
  if (!AGENT_NAMES.includes(name)) return { ok: false, error: `No agent named ${agent}: /iterate runs qwen (Qwen Code) or codex (Codex with a local model), on a local endpoint. Nothing was started.` };
  if (!LOCAL_AGENTS.includes(name)) return { ok: false, error: `${AGENTS[name].title} runs on your own account and costs money; /iterate runs only a local, free route (--agent qwen or --agent codex, on a local endpoint). Nothing was started.` };
  // R4 (H33): every target takes the local Codex route (H25) now, under the same rule as /iterate tray: a local
  // endpoint, no cloud model, no --paid, and a model this machine's Ollama already lists (checked before anything runs).
  const chosen = { instruction, agent: name, ...(model?.trim() ? { model: model.trim() } : {}) };
  if (file) return { ok: true, request: { recipe: what as NativeIterateRequest['recipe'], file, ...chosen } };
  return { ok: true, request: script ? { recipe: 'blender', script, ...chosen } : { recipe: 'tray', ...chosen } };
}

interface FlowRun {
  id: string;
  root: string;
  project: string;
  record: FlowRecord;
  abort: AbortController;
  step: FlowStep | 'done';
  agentJob?: string;
  agentRecord?: AgentRunRecord;
  watcherJob?: string;
  uuid?: string;
  readbackJob?: string;
  done?: Promise<FlowRecord>;
  /** set once the flow's record and receipt are made */
  receipt?: string;
  recordFile?: string;
}

/** A start: the flow and what /iterate prints, or why nothing was started. */
type Started = { ok: true; flow: FlowRun; lines: Line[] } | { ok: false; error: string; lines: Line[] };

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const TERMINAL_RECIPE = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);
const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms).unref?.(); });
const within = <T>(p: Promise<T>, ms: number): Promise<T | undefined> =>
  Promise.race([p, new Promise<undefined>((resolve) => { setTimeout(() => resolve(undefined), ms).unref?.(); })]);
const fmt = (n: number): string => String(Math.round(n * 1000) / 1000);

export class IterateFlows {
  private readonly running = new Map<string, FlowRun>();
  /** R4 (H26): the Blender flows (src/repl/iterate-blender.ts); one flow of any kind at a time runs in a project. */
  private readonly blender: BlenderFlows;
  /** R4 (H33): the OpenSCAD and FreeCAD flows (src/repl/iterate-scad.ts, src/repl/iterate-freecad.ts). */
  private readonly scad: ScadFlows;
  private readonly freecad: FreecadFlows;
  /** R4 review (R4-5): the projects a start holds, of any kind (src/repl/flow-lock.ts); every start below takes it. */
  private readonly lock = new FlowLock();

  constructor(private readonly d: IterateDeps) {
    const tray = (root: string): { id: string; step: string } | undefined => { const f = [...this.running.values()].find((x) => x.root === root); return f ? { id: f.id, step: f.step } : undefined; };
    this.blender = new BlenderFlows(d, (root) => tray(root) ?? this.scad.runningIn(root) ?? this.freecad.runningIn(root), this.lock);
    this.scad = new ScadFlows(d, (root) => tray(root) ?? this.blender.runningIn(root) ?? this.freecad.runningIn(root), this.lock);
    this.freecad = new FreecadFlows(d, (root) => tray(root) ?? this.blender.runningIn(root) ?? this.scad.runningIn(root), this.lock);
  }

  /**
   * R4 review (R4-5): runs a start holding its project (src/repl/flow-lock.ts), taken before the start's first await and
   * given back when it ends, however it ends. A start made while another holds the project is refused with its own kind's
   * words, naming the flow being started there (its prepare step); a flow already running is found by the start itself.
   */
  private async exclusive<S>(kind: FlowKind, root: string, start: () => Promise<S>): Promise<S | Refused> {
    const t = this.lock.take(root, kind);
    if (!t.ok) return this.busyRefusal(kind, { ...(t.by.id ? { id: t.by.id } : {}), step: 'prepare' });
    try { return await start(); } finally { this.lock.release(t.hold); }
  }

  /** A start refused because a flow runs, or is being started, in its project: the refused kind's words, nothing written. */
  private busyRefusal(kind: FlowKind, busy: { id?: string; step: string }): Refused {
    const who = busy.id ? `Flow ${busy.id} is still running in this project (its ${busy.step} step)` : `A flow is being started in this project (its ${busy.step} step)`;
    const rule = kind === 'tray' ? `one flow at a time changes ${paramsPath()}` : 'one flow at a time runs in a project (an agent\'s before/after comparison covers all of it)';
    const error = `${who}, and ${rule}: wait for it${busy.id ? `, or /stop ${busy.id}` : ''}. Nothing was started.`;
    return { ok: false, error, lines: this.say(error, 'estimate') };
  }

  /** R4 review (R4-3): the flow of any kind running in a project, or being started there (its id once it has one). */
  runningIn(root: string): { id?: string; step: string } | undefined {
    const tray = [...this.running.values()].find((f) => f.root === root);
    const held = this.lock.holder(root);
    return tray ? { id: tray.id, step: tray.step } : this.otherIn(root) ?? (held ? { ...(held.id ? { id: held.id } : {}), step: 'prepare' } : undefined);
  }

  private get sep(): string { return ` ${this.d.glyphs.sep} `; }
  private say(text: string, role: Segment['role'] = 'secondary'): Line[] { return [[{ text: `  ${text}`, role }]]; }

  /** The flows this REPL is running (their ids). */
  get active(): string[] { return [...this.running.keys(), ...this.blender.active, ...this.scad.active, ...this.freecad.active]; }

  /** The flow running (or being started) in a project, of any kind other than the tray's. */
  private otherIn(root: string): { id: string; step: string } | undefined {
    return this.blender.runningIn(root) ?? this.scad.runningIn(root) ?? this.freecad.runningIn(root);
  }

  /** `/iterate` (usage and the project's flows), or `/iterate tray "<instruction>" …` (starts one). */
  async command(args: string, at: { root: string; project: string }): Promise<Line[]> {
    const a = args.trim();
    if (!a) return this.usage(at);
    const p = parseIterateLine(a);
    if (!p.ok) return this.say(p.error, /^Usage|^Say what|^Name the (script|model)/.test(p.error) ? 'secondary' : 'failure');
    // R4 review (R4-5): every start holds its project until it ends (exclusive).
    const req = p.request;
    // R4 (H26): /iterate blender <script.py> "<instruction>"
    if (req.recipe === 'blender') return (await this.exclusive('blender', at.root, () => this.blender.start(req, at))).lines;
    // R4 (H33): /iterate scad <model.scad> "<instruction>", /iterate freecad <script.py> "<instruction>"
    if ('file' in req) return (await this.exclusive(req.recipe, at.root, async () => (req.recipe === 'scad' ? await this.scad.start(req, at) : await this.freecad.start(req, at)))).lines;
    return (await this.exclusive('tray', at.root, () => this.start(req, at))).lines;
  }

  /**
   * R4 (H33): the agent's iterate_native (src/agent/iterate-tools.ts): the same start as `/iterate scad <model>` or
   * `/iterate freecad <script>` with the operator's own model setting (Qwen Code's local route), answered as data.
   * Started is never finished: the flow runs on.
   */
  async startNativeForTool(req: { target: 'scad' | 'freecad'; file: string; instruction: string }, at: { root: string; project: string }): Promise<Record<string, unknown>> {
    const request: NativeIterateRequest = { recipe: req.target, file: req.file, instruction: req.instruction, agent: 'qwen' };
    const s = await this.exclusive(req.target, at.root, async () => (req.target === 'scad' ? await this.scad.start(request, at) : await this.freecad.start(request, at)));
    if (!s.ok) return { ok: false, started: false, error: s.error };
    const r = s.flow.record;
    const changes = isScadFlowRecord(r) ? r.parameters : (r as FreecadFlowRecord).script;
    return {
      ok: true, flow: s.flow.id, target: req.target, agent_job: s.flow.agentJob, agent_run: r.agent?.run, route: r.agent?.route,
      file_the_agent_may_change: { path: changes.path, sha256: changes.before.sha256 },
      record_when_done: flowRecordPath(s.flow.id),
      note: req.target === 'scad'
        ? `Started, not finished: the local agent may change only the values in ${changes.path}; then OpenSCAD exports the model as a judged job, and Timmy's reading of its STL is compared with OpenSCAD's own summary. The operator follows it with /iterate and /jobs ${s.flow.agentJob}, and stops it with /stop ${s.flow.id}. Do not claim the model is exported or measured.`
        : `Started, not finished: the local agent may change only ${changes.path}; then FreeCAD runs it as a judged job, and its STEP is read back in a separate process when TIMMY_CADQUERY_PYTHON is set. The operator follows it with /iterate and /jobs ${s.flow.agentJob}, and stops it with /stop ${s.flow.id}. Do not claim the part is built or measured.`,
      doctrine: DOCTRINE_15,
    };
  }

  /**
   * The agent's iterate_recipe (src/agent/iterate-tools.ts): the same start as `/iterate tray "<instruction>"`
   * with the operator's own model setting, answered as data. Started is never finished: the flow runs on.
   */
  async startForTool(instruction: string, at: { root: string; project: string }): Promise<Record<string, unknown>> {
    const s = await this.exclusive('tray', at.root, () => this.start({ recipe: 'tray', instruction, agent: 'qwen' }, at));
    if (!s.ok) return { ok: false, started: false, error: s.error };
    const r = s.flow.record;
    return {
      ok: true, flow: s.flow.id, agent_job: s.flow.agentJob, agent_run: r.agent?.run, route: r.agent?.route,
      parameters_file: { path: r.parameters.path, sha256: r.parameters.before.sha256, values: r.parameters.before.values, written_from_defaults: r.parameters.created },
      record_when_done: flowRecordPath(s.flow.id),
      note: `Started, not finished: the local agent may change only ${r.parameters.path}; then the recipe rebuilds as a durable job and a separate worker reads its STEP back. The operator follows it with /iterate and /jobs ${s.flow.agentJob}, and stops it with /stop ${s.flow.id}. Do not claim the tray is rebuilt or measured.`,
      doctrine: DOCTRINE_15,
    };
  }

  private usage(at: { root: string; project: string }): Line[] {
    const lines: Line[] = [
      [{ text: '  Iterate    ', role: 'secondary' }, { text: USAGE, role: 'strong' }],
      ...this.say(`           a local code agent changes ${paramsPath()}; the recipe rebuilds as a durable job; a separate worker reads the STEP back; each flow is kept in results/flows/`),
      [{ text: '  Agent      ', role: 'secondary' }, { text: 'qwen (Qwen Code), or codex (Codex with a local model: codex exec --oss), on a local endpoint only: no charge; there is no --paid here' }],
    ];
    const file = readParams(at.root);
    lines.push(file.ok && file.exists
      ? [{ text: '  Parameters ', role: 'secondary' }, { text: file.path, role: 'strong' }, { text: `  ${PARAMETER_NAMES.map((n) => `${n} ${fmt(file.parameters[n])}`).join(', ')}${this.sep}sha256 ${short(file.sha256)}`, role: 'secondary' }]
      : file.ok
        ? [{ text: '  Parameters ', role: 'secondary' }, { text: `no ${paramsPath()} yet: the first /iterate writes it from the recipe card's defaults`, role: 'secondary' }]
        : [{ text: '  Parameters ', role: 'secondary' }, { text: `${file.path} is not usable: ${file.error}`, role: 'failure' }]);
    lines.push([{ text: '  Ranges     ', role: 'secondary' }, { text: PARAMETER_NAMES.map((n) => `${n}: ${PARAMETER_HELP[n]}`).join(this.sep), role: 'secondary' }]);
    const rt = nativeRuntime(this.d.env());
    lines.push(rt.ok
      ? [{ text: '  Runtime    ', role: 'secondary' }, { text: 'TIMMY_CADQUERY_PYTHON is set', role: 'strong' }, { text: `${this.sep}it builds the recipe and reads its STEP back; checked when a flow runs, not now`, role: 'secondary' }]
      : [{ text: '  Runtime    ', role: 'secondary' }, { text: rt.why, role: 'estimate' }, { text: `${this.sep}${PYTHON_SETUP}`, role: 'secondary' }]);
    lines.push(...this.blender.usageLines()); // R4 (H26)
    lines.push(...this.scad.usageLines(), ...this.freecad.usageLines()); // R4 (H33)
    const flows = this.flowRows(at.root);
    lines.push([{ text: '  Flows      ', role: 'secondary' }, { text: flows.length ? 'newest first' : 'none yet in this project', role: 'secondary' }]);
    for (const r of flows.slice(0, 8)) lines.push(r);
    lines.push(...this.say(DOCTRINE_15, 'strong'));
    return lines;
  }

  /** The project's flows: the running ones (this REPL) first, then the records in results/flows/. */
  private flowRows(root: string): Line[] {
    const g = this.d.glyphs;
    const rows: Line[] = [];
    const live = [...this.running.values()].filter((f) => f.root === root);
    for (const f of live) rows.push([{ text: `    ${g.bullet} ` }, { text: f.id, role: 'strong' }, { text: `  running: the ${f.step} step${this.sep}/stop ${f.id}${this.sep}${this.d.scrub(f.record.instruction, root).slice(0, 60)}`, role: 'secondary' }]);
    rows.push(...this.blender.runningRows(root)); // R4 (H26)
    rows.push(...this.scad.runningRows(root), ...this.freecad.runningRows(root)); // R4 (H33)
    for (const { rel, record } of listFlows(root)) {
      if (live.some((f) => f.id === record.id) || this.blender.has(record.id) || this.scad.has(record.id) || this.freecad.has(record.id)) continue;
      const ok = record.outcome === 'succeeded';
      // R4 (H33): an OpenSCAD or FreeCAD flow says its own change (its parameter values are not all numbers).
      const native = scadFlowSummary(record, g.arrow) || freecadFlowSummary(record);
      const diff = native || (record.parameters?.diff ? diffText(record.parameters.diff, g.arrow) : blenderFlowSummary(record));
      const verdict = record.readback?.verdict ? `${this.sep}readback ${record.readback.verdict}` : '';
      rows.push([{ text: `    ${ok ? g.ok : record.outcome === 'cancelled' ? ' ' : g.fail} `, role: ok ? undefined : record.outcome === 'cancelled' ? undefined : 'failure' }, { text: record.id, role: 'strong' },
        { text: `  ${String(record.outcome).padEnd(9)} ${diff}${verdict}${this.sep}${rel}`, role: 'secondary' }]);
    }
    return rows;
  }

  private async start(req: IterateRequest, at: { root: string; project: string }): Promise<Started> {
    const { root, project } = at;
    const g = this.d.glyphs;
    /** A refusal: nothing was started; the reason as one sentence, and as the lines /iterate prints. */
    const refuse = (error: string, role: Segment['role'] = 'failure', more: Line[] = [], before: Line[] = []): Started => ({ ok: false, error, lines: [...before, ...this.say(error, role), ...more] });
    const env: NodeJS.ProcessEnv = { ...this.d.env(), ...(req.model ? { TIMMY_AGENT_MODEL: req.model } : {}) };
    const info = AGENTS[req.agent];
    // The route first, before anything is written: local and free, or refused with the reason.
    const bin = agentBin(req.agent, env, this.d.onPath);
    if (!bin) return refuse(`${info.title} is not on PATH (${info.bin}); /tools says how to install it. Nothing was started.`, 'estimate');
    if (!env.TIMMY_AGENT_MODEL?.trim()) return refuse(`Name the local model: ${USAGE.replace('[--model <local model>]', '--model <a model your local endpoint serves, from ollama list>')}, or set TIMMY_AGENT_MODEL. Nothing was started.`);
    // R4 (H25): codex runs here only as Codex's local route (codex exec --oss), never on the user's account.
    const local = req.agent === 'codex' ? { local: true as const } : {};
    const route = planAgent(req.agent, req.instruction, { env, paid: false, run: 'a00000000', bin, ...local, root });
    if (!route.ok) {
      const why = route.error.replace(/\s*To run it anyway:.*$/, '');
      return route.refused === 'paid' ? refuse(`${why} /iterate runs only a local, free route, and has no --paid.`, 'estimate') : refuse(why);
    }
    // One flow at a time per project: two agents on one parameter file would make each other's changes look foreign.
    const busy = [...this.running.values()].find((f) => f.root === root) ?? this.otherIn(root);
    if (busy) return this.busyRefusal('tray', busy);
    // The build needs the recipe's runtime, so it is checked before the agent runs (not after it has worked).
    const rt = nativeRuntime(env);
    if (!rt.ok) return refuse(`Not started: ${rt.why}. /iterate rebuilds the recipe after the agent, so the runtime comes first.`, 'estimate', this.say(`Setup: ${PYTHON_SETUP}, then /iterate again.`));
    if (!this.d.test?.readback && !existsSync(READBACK_SCRIPT)) return refuse('Not started: the readback worker (workers/readback/step_readback.py) is missing from this Timmy.');
    // R4 review (R4-5): the flow's id is named to the project's hold before the first await, so a start refused
    // meanwhile names this flow.
    const id = newFlowId();
    this.lock.name(root, id);
    // R4 (H25): Codex's local route needs its model already in the local Ollama; asked before anything is written.
    if (route.plan.oss) {
      const ready = await codexLocalPreflight(route.plan.oss);
      if (!ready.ok) return refuse(this.d.scrub(ready.error, root), 'estimate');
    }
    // The parameter file: read and checked, or written from the recipe card's defaults (and said so).
    const rel = paramsPath();
    const file = readParams(root);
    if (!file.ok) return refuse(`${file.path} is not a usable parameter file: ${this.d.scrub(file.error, root)}; fix it or move it aside. Nothing was started.`);
    let created = false;
    if (!file.exists) {
      const w = writeParams(root, readCard().parameters);
      if (!w.ok) return refuse(`${w.path} could not be written from the recipe card's defaults: ${this.d.scrub(w.error, root)}. Nothing was started.`);
      created = true;
    }
    // The file's bytes now: the task quotes them, and their sha256 is the "before" every later check compares with.
    let text = '';
    try { text = readFileSync(join(root, rel), 'utf8'); } catch (e) { return refuse(`${rel} could not be read: ${this.d.scrub(e instanceof Error ? e.message : String(e), root)}. Nothing was started.`); }
    const parsed = parseParams(text);
    if (!parsed.ok) return refuse(`${rel} is not a usable parameter file: ${parsed.error}. Nothing was started.`);
    const before = { sha256: sha(text), values: parsed.parameters };
    const values = PARAMETER_NAMES.map((n) => `${n} ${fmt(before.values[n])}`).join(', ');
    // The agent, through /agent's own start: its job, its snapshot before, its sealed result at its end.
    const task = iterateTask({ instruction: req.instruction, paramsRel: rel, fileText: text });
    const s = await this.d.startAgent(req.agent, task, { paid: false, ...local, root, project, env });
    if (!s.ok) {
      const wrote = created ? this.say(`${rel} did not exist: written from the recipe card's defaults (${values})`) : [];
      return refuse(`The agent did not start: ${this.d.scrub(s.error, root)}`, s.refused === 'paid' || s.refused === 'missing' ? 'estimate' : 'failure', [], wrote);
    }
    const record: FlowRecord = {
      flow: 1, schema: FLOW_SCHEMA, id, kind: 'iterate', recipe: RECIPE_ID, instruction: req.instruction, project, started_at: new Date().toISOString(), outcome: 'running',
      parameters: { path: rel, created, before },
      agent: {
        run: s.run, agent: s.plan.agent, version: s.version, route: s.plan.charge, where: s.plan.where, model: s.plan.model, job: s.job.id,
        result: `${AGENTS_DIR}/${s.run}/result.json`, progress: `${AGENTS_DIR}/${s.run}/progress.log`,
      },
      receipts: {}, child_receipts: [], doctrine: DOCTRINE_15,
    };
    const flow: FlowRun = { id, root, project, record, abort: new AbortController(), step: 'agent', agentJob: s.job.id, agentRecord: s.record };
    this.running.set(id, flow);
    this.saveState(flow);
    flow.done = this.run(flow).finally(() => { this.running.delete(id); });
    return {
      ok: true, flow, lines: [
        [{ text: '  Flow       ', role: 'secondary' }, { text: id, role: 'strong' }, { text: `  iterate tray: ${this.d.scrub(req.instruction, root)}`, role: 'secondary' }],
        [{ text: '  Parameters ', role: 'secondary' }, { text: rel, role: 'strong' }, { text: `  ${values}${this.sep}sha256 ${short(before.sha256)}`, role: 'secondary' }],
        ...(created ? this.say(`           it did not exist: written from the recipe card's defaults before the agent ran`, 'estimate') : []),
        [{ text: '  Agent      ', role: 'secondary' }, { text: s.job.id, role: 'strong' }, { text: `  agent ${s.plan.agent} ${s.run}${this.sep}${s.info.title}${s.version ? ` ${s.version}` : ''}${s.plan.model ? `${this.sep}model ${s.plan.model} at ${s.plan.where}` : ''}${this.sep}${s.plan.charge}`, role: 'secondary' }],
        [{ text: '  Next       ', role: 'secondary' }, { text: `it may change only ${rel}; then the recipe rebuilds as a durable job and a separate worker reads the STEP back`, role: 'secondary' }],
        [{ text: '  Follow     ', role: 'secondary' }, { text: `/jobs ${s.job.id}${this.sep}/stop ${id} stops the flow${this.sep}/iterate lists flows${this.sep}the record: ${flowRecordPath(id)} ${g.arrow} /board`, role: 'secondary' }],
      ],
    };
  }

  // ── the steps ────────────────────────────────────────────────────────────────

  private async run(f: FlowRun): Promise<FlowRecord> {
    try {
      await this.agentStep(f);
      if (f.record.outcome === 'running') this.checksStep(f);
      if (f.record.outcome === 'running') await this.buildStep(f);
      if (f.record.outcome === 'running') await this.readbackStep(f);
      if (f.record.outcome === 'running') this.end(f, 'failed', 'record', 'the flow ended without a verdict');
    } catch (e) {
      this.end(f, f.abort.signal.aborted ? 'cancelled' : 'failed', f.step === 'done' ? 'record' : f.step, `the flow could not go on: ${this.d.scrub(e instanceof Error ? e.message : String(e), f.root)}`);
    }
    return this.finish(f);
  }

  /** Ends the flow (once): its outcome, the step it ended in, and why. */
  private end(f: FlowRun, outcome: Exclude<FlowOutcome, 'running'>, step: FlowStep, why: string): void {
    if (f.record.outcome !== 'running') return;
    f.record.outcome = outcome;
    f.record.ended_in = step;
    f.record.why = why;
  }

  private stopped(f: FlowRun): boolean { return f.abort.signal.aborted; }

  private note(f: FlowRun, text: string, role: Segment['role'] = 'secondary'): void {
    this.d.notify([{ text: `  ${this.d.glyphs.bullet} ` }, { text: f.id, role: 'strong' }, { text: `  ${text}`, role }]);
  }

  private saveState(f: FlowRun): void {
    writeProjectJson(f.root, `${flowWorkDir(f.id)}/state.json`, { ...f.record, step: f.step });
  }

  private async agentStep(f: FlowRun): Promise<void> {
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
    const kept = a.transcript ? `; its output is kept: ${a.transcript}` : '';
    if (this.stopped(f) || a.outcome === 'cancelled' || job.state === 'cancelled') return this.end(f, 'cancelled', 'agent', `stopped with /stop during the agent step; nothing was built${kept}`);
    if (a.outcome !== 'completed') return this.end(f, 'failed', 'agent', `the agent run ended ${a.outcome}${a.why ? `: ${a.why}` : ''}; nothing was built${kept}`);
    this.saveState(f);
  }

  private checksStep(f: FlowRun): void {
    f.step = 'checks';
    const rel = f.record.parameters.path;
    const a = f.record.agent!;
    const kept = a.transcript ? `; the agent's output is kept: ${a.transcript}` : '';
    const judged = judgeAgentChanges(f.agentRecord?.files, rel);
    if (!judged.ok) {
      if (judged.others.length) a.others = judged.others;
      return this.end(f, 'stopped', 'checks', `${judged.why}; nothing was built, and nothing was reverted${kept}`);
    }
    // The file as it is now, read here (not the agent's word): it must be what the agent's own snapshot saw.
    let text: string;
    try { text = readFileSync(join(f.root, rel), 'utf8'); } catch { return this.end(f, 'stopped', 'checks', `${rel} cannot be read after the agent's run; nothing was built`); }
    const now = sha(text);
    const seen = judged.params === 'changed' ? judged.change?.sha256 ?? null : f.record.parameters.before.sha256;
    if (seen !== now) return this.end(f, 'stopped', 'checks', `${rel} changed after the agent's run ended (sha256 ${short(now)} now; the agent left ${seen ? short(seen) : 'an unhashed file'}); nothing was built`);
    if (judged.params === 'unchanged') return this.end(f, 'stopped', 'checks', 'the agent changed nothing; nothing was rebuilt');
    const parsed = parseParams(text);
    if (!parsed.ok) {
      f.record.parameters.invalid = { sha256: now, error: parsed.error };
      return this.end(f, 'stopped', 'checks', `${rel} as the agent left it is not valid: ${parsed.error}; it is left as the agent wrote it; nothing was rebuilt${kept}`);
    }
    const diff = paramDiff(f.record.parameters.before.values, parsed.parameters);
    f.record.parameters.after = { sha256: now, values: parsed.parameters };
    f.record.parameters.diff = diff;
    if (!diff.some((x) => x.changed)) return this.end(f, 'stopped', 'checks', `the agent rewrote ${rel} but changed no value; nothing was rebuilt`);
    this.note(f, `agent ${a.agent} ${a.run} completed: changed ${rel}${this.sep}${diffText(diff, this.d.glyphs.arrow)}`);
    this.saveState(f);
  }

  private statusOf(f: FlowRun): { state: string; progress?: string; reason?: string; error?: string } {
    try { const s = status(f.root, f.uuid!); return { state: s.state, progress: s.progress, ...(s.reason ? { reason: s.reason } : {}) }; } catch (e) {
      return { state: 'unreadable', error: this.d.scrub(e instanceof Error ? e.message : String(e), f.root) };
    }
  }

  /** The recipe's own cancel (it writes the job's cancel request; its supervisor stops its own process group), then the watcher. */
  private async cancelBuild(f: FlowRun): Promise<void> {
    if (f.uuid) { try { cancel(f.root, f.uuid); } catch { /* already ended, or unreadable: status says which */ } }
    if (f.watcherJob) await this.d.jobs.stop(f.watcherJob);
  }

  private async buildStep(f: FlowRun): Promise<void> {
    f.step = 'build';
    if (this.stopped(f)) return this.end(f, 'cancelled', 'build', 'stopped with /stop before the rebuild started; nothing was built');
    const after = f.record.parameters.after!;
    // The checked values are given whole, so the request is exactly what was checked and diffed.
    const r = await this.d.startRecipe(f.root, f.project, after.values);
    if (!r.ok) {
      f.record.rebuild = { state: 'not started', stage: r.stage, error: this.d.scrub(r.error, f.root), ...(r.operation ? { operation: r.operation } : {}) };
      if (r.operation) f.uuid = r.operation;
      return this.end(f, 'failed', 'build', `the recipe did not start (${r.stage}): ${this.d.scrub(r.error, f.root)}`);
    }
    f.uuid = r.operation;
    f.watcherJob = r.job;
    f.record.rebuild = {
      operation: r.operation, job: r.job, state: 'running', request_sha256: r.request_sha256, source_sha256: r.source_sha256,
      predicted: r.predicted, prediction_receipt: r.prediction_receipt, ...(r.parameters_file ? { parameters_file: r.parameters_file } : {}),
    };
    f.record.receipts.prediction = r.prediction_receipt;
    if (r.parameters_file && r.parameters_file.sha256 !== after.sha256) {
      f.record.rebuild.discrepancies = [`the parameter file read at the start (sha256 ${short(r.parameters_file.sha256)}) is not the file checked (sha256 ${short(after.sha256)}); the build was given the checked values`];
    }
    this.note(f, `rebuild: recipe job ${r.operation} (${r.job})${this.sep}predicted ${mmText(r.predicted.bounds_mm)} mm, ${mm3Text(r.predicted.volume_mm3)} mm3, sealed first${this.sep}receipt ${r.prediction_receipt}`);
    this.saveState(f);
    // A stop that came while the job was being started: the recipe's own cancel, then the watcher.
    if (this.stopped(f)) await this.cancelBuild(f);
    const watcher = await this.d.jobs.done(r.job);
    if (watcher.receipt) { f.record.rebuild.receipt = watcher.receipt; f.record.receipts.build = watcher.receipt; }
    let s = this.statusOf(f);
    if (!TERMINAL_RECIPE.has(s.state) && s.state !== 'unreadable') {
      // The watcher ended before the recipe did: stopped, or it failed. A stopped one is cancelled through the
      // recipe's own path (again: the request is written once); either way its final state is waited for.
      if (this.stopped(f) || watcher.state === 'cancelled') { try { cancel(f.root, f.uuid); } catch { /* status says */ } }
      const until = Date.now() + (this.stopped(f) || watcher.state === 'cancelled' ? this.d.test?.settleMs ?? 15_000 : 180_000);
      while (!TERMINAL_RECIPE.has(s.state) && s.state !== 'unreadable' && Date.now() < until) { await sleep(100); s = this.statusOf(f); }
    }
    Object.assign(f.record.rebuild, { state: s.state, ...(s.progress ? { progress: s.progress } : {}), ...(s.reason ? { reason: this.d.scrub(s.reason, f.root) } : {}), ...(s.error ? { error: s.error } : {}) });
    if (s.state === 'succeeded') {
      const copy = checkCopy(f.root, f.uuid);
      if (!copy.ok) return this.end(f, 'failed', 'build', `recipe job ${f.uuid} succeeded, but its exports are not in the project: ${this.d.scrub(copy.error, f.root)}; /recipe copy ${f.uuid}`);
      f.record.rebuild.outputs = copy.v.files.map((x) => ({ path: `${copy.dir}/${x.name}`, sha256: x.sha256, bytes: x.bytes.length }));
      if (this.stopped(f)) return this.end(f, 'cancelled', 'build', `stopped with /stop as the rebuild finished: recipe job ${f.uuid} succeeded and its exports are in ${copy.dir}/; no readback was made`);
      this.saveState(f);
      return;
    }
    const kept = failureFiles(f.root, f.uuid);
    if (kept.length) f.record.rebuild.failure_files = kept;
    const where = kept.length ? `; kept: ${kept.join(', ')}` : '';
    if (s.state === 'cancelled' || this.stopped(f)) {
      return this.end(f, 'cancelled', 'build', `stopped with /stop during the build: recipe job ${f.uuid} ${s.state}${s.progress ? ` (${s.progress})` : ''} through the recipe's own cancel path; partial artifacts are kept and nothing is replayed${where}`);
    }
    return this.end(f, 'failed', 'build', `recipe job ${f.uuid} ${s.state}${s.reason ? `: ${this.d.scrub(s.reason, f.root)}` : s.error ? `: ${s.error}` : ''}; nothing was read back${where}`);
  }

  private async readbackStep(f: FlowRun): Promise<void> {
    f.step = 'readback';
    const rb = f.record.rebuild!;
    const step = rb.outputs?.find((o) => o.path.endsWith(`/${STEP_EXPORT}`));
    f.record.readback = { state: 'not started', tolerance: { ...READBACK_TOLERANCE }, scope: READBACK_SCOPE, ...(step ? { step: { path: step.path, sha256: step.sha256 } } : {}) };
    const r = f.record.readback;
    if (!step) return this.end(f, 'failed', 'readback', `the delivered outputs hold no ${STEP_EXPORT}; nothing was read back`);
    if (this.stopped(f)) { r.state = 'cancelled'; return this.end(f, 'cancelled', 'readback', 'stopped with /stop before the readback started; the rebuild had finished'); }
    const rt = nativeRuntime(this.d.env());
    const abs = join(f.root, step.path);
    let cmd: { command: string; args: string[] };
    if (this.d.test?.readback) cmd = this.d.test.readback({ abs, rel: step.path });
    else if (rt.ok) cmd = { command: rt.python, args: [READBACK_SCRIPT, abs, '--as', step.path] };
    else { r.state = 'not started'; r.verdict = 'failed'; r.reason = `${rt.why}: ${PYTHON_SETUP}`; return this.end(f, 'failed', 'readback', `the readback did not start: ${rt.why}`); }
    let job: JobRecord;
    try {
      job = this.d.startJob({ kind: 'task', label: `readback ${step.path} · flow ${f.id}`, project: f.project, root: f.root, command: cmd.command, args: cmd.args, timeoutMs: READBACK_TIMEOUT_MS }, { selfSealed: true });
    } catch (e) {
      r.verdict = 'failed';
      r.reason = this.d.scrub(e instanceof Error ? e.message : String(e), f.root);
      return this.end(f, 'failed', 'readback', `the readback did not start: ${r.reason}`);
    }
    f.readbackJob = job.id;
    r.job = job.id;
    r.state = 'running';
    this.note(f, `readback: ${job.id} reads ${step.path} back in its own process${this.sep}/jobs ${job.id}`);
    this.saveState(f);
    if (this.stopped(f)) await this.d.jobs.stop(job.id);
    const done = await this.d.jobs.done(job.id);
    // The worker's raw output (stdout and stderr, as the job logged them) is kept with the flow's files.
    const logRel = `${flowWorkDir(f.id)}/readback.log`;
    let logSha: string | undefined;
    let logBytes = 0;
    try {
      mkdirSync(dirname(join(f.root, logRel)), { recursive: true });
      copyFileSync(done.logPath, join(f.root, logRel));
      const b = readFileSync(join(f.root, logRel));
      logSha = sha(b);
      logBytes = b.length;
      r.log = logRel;
    } catch { /* the job's own log stays in the jobs folder */ }
    r.state = done.state;
    const finish = (verdict: 'matches' | 'differs' | 'failed' | undefined, outcome: Exclude<FlowOutcome, 'running'>, why: string): void => {
      if (verdict) r.verdict = verdict;
      const receipt = done.receipt ?? this.sealReadback(f, done, logSha ? { sha256: logSha, bytes: logBytes } : undefined);
      if (receipt) { r.receipt = receipt; f.record.receipts.readback = receipt; }
      this.end(f, outcome, 'readback', why);
    };
    if (this.stopped(f) || done.state === 'cancelled') {
      r.state = 'cancelled';
      r.reason = 'stopped with /stop before it finished: no verdict';
      return finish(undefined, 'cancelled', `stopped with /stop during the readback; the rebuild had finished; no verdict${r.log ? `; its output so far: ${r.log}` : ''}`);
    }
    let size = 0;
    try { size = statSync(done.logPath).size; } catch { size = 0; }
    const parsed: ReadbackMeasured | ReadbackFailure = size > READBACK_MAX_OUTPUT
      ? { ok: false, code: 'too-much-output', error: `the worker printed more than ${READBACK_MAX_OUTPUT} bytes` }
      : parseReadbackOutput(this.d.jobs.tail(job.id, 400).join('\n'));
    if (parsed.worker) r.worker = parsed.worker;
    const kept = r.log ? `; its output is kept: ${r.log}` : '';
    if (!parsed.ok) {
      r.reason = this.d.scrub(`${parsed.code}: ${parsed.error}`, f.root);
      return finish('failed', 'failed', `the readback failed: ${r.reason}${done.state !== 'completed' ? ` (${done.error ?? `exit ${done.exitCode ?? done.signal ?? '?'}`})` : ''}${kept}`);
    }
    if (done.state !== 'completed') {
      r.reason = `the worker reported values but ${done.error ?? `exited ${done.exitCode ?? done.signal ?? '?'}`}`;
      return finish('failed', 'failed', `the readback failed: ${r.reason}${kept}`);
    }
    if (parsed.engine) r.engine = parsed.engine;
    r.measured = { bounds_mm: parsed.bounds.size, volume_mm3: parsed.volume_mm3, valid: parsed.valid, solids: parsed.solids, sha256: parsed.source.sha256, ...(parsed.unit_in_effect !== undefined ? { unit_in_effect: parsed.unit_in_effect } : {}) };
    if (parsed.source.sha256 !== step.sha256) {
      r.reason = `the worker read bytes other than the delivered STEP (sha256 ${short(parsed.source.sha256)}, delivered ${short(step.sha256)})`;
      return finish('failed', 'failed', `the readback failed: ${r.reason}`);
    }
    const predicted = rb.predicted!;
    const cmp = compareReadback({ bounds: predicted.bounds_mm, volume: predicted.volume_mm3 }, parsed);
    r.checks = cmp.checks;
    if (cmp.verdict === 'matches') return finish('matches', 'succeeded', 'the readback of the delivered STEP matches the sealed prediction');
    const off = cmp.checks.filter((c) => !c.passed).map((c) => `${c.name}: measured ${String(c.measured)}, predicted ${String(c.predicted)}${c.difference !== null ? ` (difference ${c.difference.toPrecision(3)})` : ''}`).join('; ');
    return finish('differs', 'differs', `the readback differs from the sealed prediction: ${off}`);
  }

  /** The readback's receipt (kind readback): what it read (in sources, not files: it changed nothing), its job, what it measured and the verdict. */
  private sealReadback(f: FlowRun, job: JobRecord, log?: { sha256: string; bytes: number }): string | undefined {
    const r = f.record.readback!;
    const ms = job.endedAt ? Date.parse(job.endedAt) - Date.parse(job.startedAt) : undefined;
    const failing = (r.checks ?? []).filter((c) => !c.passed).map((c) => `${c.name}: measured ${String(c.measured)}, predicted ${String(c.predicted)}`);
    try {
      return this.d.seal({
        kind: 'readback', subject: `readback · ${r.step?.path ?? STEP_EXPORT} · ${r.verdict ?? r.state}`, policy: 'human-gated',
        status: r.verdict === 'matches' ? 'ok' : r.state === 'cancelled' ? 'cancelled' : 'failed',
        project: f.project, project_id: projectId(f.root),
        job: { id: job.id, kind: job.kind, label: this.d.scrub(job.label, f.root), state: job.state, exit_code: job.exitCode ?? null, ...(ms !== undefined ? { ms } : {}), ...(job.error ? { error: this.d.scrub(job.error, f.root) } : {}) },
        ...(log && r.log ? { outputs: [{ path: r.log, sha256: log.sha256, bytes: log.bytes }] } : {}),
        sources: [
          ...(r.step ? [{ path: r.step.path, sha256: r.step.sha256, role: 'read' }] : []),
          { flow: f.id, worker: r.worker ? `${r.worker.name} ${r.worker.version}` : null, measured: r.measured ?? null, predicted: f.record.rebuild?.predicted ?? null, tolerance: r.tolerance, verdict: r.verdict ?? null, scope: READBACK_SCOPE, units: 'mm' },
        ],
        ...(f.record.receipts.prediction ? { child_receipts: [f.record.receipts.prediction] } : {}),
        ...(failing.length ? { discrepancies: failing } : r.reason ? { discrepancies: [r.reason] } : {}),
      });
    } catch { return undefined; }
  }

  /** The record (results/flows/<flow-id>.json), the flow receipt binding its sha256 and the child receipts, the notice. */
  private finish(f: FlowRun): FlowRecord {
    f.step = 'record';
    const rec = f.record;
    rec.ended_at = new Date().toISOString();
    const r = rec.receipts;
    rec.child_receipts = [r.agent, r.prediction, r.build, r.readback].filter((x): x is string => typeof x === 'string');
    const w = writeFlowRecord(f.root, rec);
    const status = rec.outcome === 'succeeded' ? 'ok' as const : rec.outcome === 'cancelled' ? 'cancelled' as const : 'failed' as const;
    const cost = rec.agent?.cost_usd;
    let receipt: string | undefined;
    try {
      receipt = this.d.seal({
        kind: 'flow', subject: `flow · iterate · tray · ${f.id} · ${rec.outcome}`, policy: 'human-gated', status,
        project: f.project, project_id: projectId(f.root),
        prompt_hash: `sha256:${sha(rec.instruction)}`,
        ...(w.ok ? { outputs: [{ path: w.path, sha256: w.sha256, bytes: w.bytes }] } : { discrepancies: [`the flow record could not be written: ${this.d.scrub(w.error, f.root)}`] }),
        ...(rec.parameters.created ? { files: [{ path: rec.parameters.path, sha256: rec.parameters.before.sha256, created: true }] } : {}),
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

  private endLines(f: FlowRun, file: string | undefined, receipt: string | undefined): Line[] {
    const g = this.d.glyphs;
    const rec = f.record;
    const ok = rec.outcome === 'succeeded';
    const tail = `${file ? `${this.sep}record ${file}` : `${this.sep}the record could not be written`}${receipt ? `${this.sep}receipt ${receipt}` : ''}`;
    const lines: Line[] = [[{ text: `  ${ok ? g.ok : rec.outcome === 'cancelled' ? ' ' : g.fail} `, role: ok || rec.outcome === 'cancelled' ? undefined : 'failure' },
      { text: `${f.id} ${rec.outcome}`, role: ok || rec.outcome === 'cancelled' ? 'strong' : 'failure' }, { text: `: ${rec.why ?? ''}${tail}`, role: 'secondary' }]];
    const m = rec.readback?.measured;
    if (m && rec.readback) {
      lines.push([{ text: '      measured from the CAD file: ', role: 'secondary' }, { text: `${mmText(m.bounds_mm)} mm, ${mm3Text(m.volume_mm3)} mm3, ${m.solids} ${m.valid ? 'valid ' : 'invalid '}solid${m.solids === 1 ? '' : 's'}`, role: 'strong' },
        { text: `${this.sep}${rec.readback.worker ? `${rec.readback.worker.name} ${rec.readback.worker.version}` : 'worker unknown'}${this.sep}within ${toleranceText(rec.readback.tolerance)} of the prediction: ${rec.readback.verdict}`, role: 'secondary' }]);
      lines.push([{ text: `      ${DOCTRINE_15}`, role: 'strong' }]);
    }
    return lines;
  }

  // ── stopping ─────────────────────────────────────────────────────────────────

  /** `/stop <flow-id>`: stops the step that runs, waits for the record, and says what happened. */
  async stop(id: string, root: string): Promise<Line[]> {
    if (this.blender.has(id)) return this.blender.stop(id); // R4 (H26)
    if (this.scad.has(id)) return this.scad.stop(id); // R4 (H33)
    if (this.freecad.has(id)) return this.freecad.stop(id);
    const f = this.running.get(id);
    if (!f) {
      const known = FLOW_ID.test(id) ? listFlows(root).find((x) => x.record.id === id) : undefined;
      return known ? this.say(`${id} already ended (${known.record.outcome}): ${known.rel}.`) : this.say(`No flow ${id} is running in this REPL: /iterate lists the flows.`);
    }
    const step = f.step;
    f.abort.abort();
    if (step === 'agent' && f.agentJob) await this.d.jobs.stop(f.agentJob);
    else if (step === 'build') await this.cancelBuild(f);
    else if (step === 'readback' && f.readbackJob) await this.d.jobs.stop(f.readbackJob);
    const rec = f.done ? await within(f.done, 60_000) : undefined;
    if (!rec) return this.say(`${id}: stopping (it was in the ${step} step); its record is not written yet: /iterate`, 'estimate');
    return [[{ text: `  ${id} ${rec.outcome}`, role: rec.outcome === 'cancelled' ? 'strong' : 'failure' },
      { text: `  ${rec.why ?? ''}${f.recordFile ? `${this.sep}record ${f.recordFile}` : ''}${f.receipt ? `${this.sep}receipt ${f.receipt}` : ''}`, role: 'secondary' }]];
  }

  /**
   * /stop all and the REPL's end: every flow is marked stopped, so none starts a next step; a flow in its build
   * asks the recipe's own cancel now (the jobs themselves are stopped by the caller, as this REPL's jobs).
   * Returns how many flows were running, and a report of how each ended (it waits, at most `ms`, for them).
   */
  abortAll(): { count: number; report: (ms?: number) => Promise<string | undefined> } {
    const live = [...this.running.values()];
    for (const f of live) {
      f.abort.abort();
      if (f.step === 'build' && f.uuid) { try { cancel(f.root, f.uuid); } catch { /* status says */ } }
    }
    const blender = this.blender.abortAll(); // R4 (H26)
    const natives = [this.scad.abortAll(), this.freecad.abortAll()]; // R4 (H33)
    const others = [blender, ...natives];
    const count = live.length + others.reduce((n, o) => n + o.count, 0);
    return {
      count,
      report: async (ms = 20_000) => {
        if (!count) return undefined;
        await within(Promise.allSettled([...live.map((f) => f.done), ...others.flatMap((o) => o.done)]), ms);
        const each = [...live.map((f) => `${f.id} ${f.step === 'done' ? f.record.outcome : `still stopping (in its ${f.step} step)`}`), ...others.flatMap((o) => o.describe())].join(', ');
        return `Flows (/iterate): ${each}; none starts a next step, and each keeps its record in results/flows/.`;
      },
    };
  }

  /** Waits (at most `ms`) for every running flow to write its record. */
  async settle(ms = 30_000): Promise<void> {
    await within(Promise.allSettled([...[...this.running.values()].map((f) => f.done), ...this.blender.pending(), ...this.scad.pending(), ...this.freecad.pending()]), ms);
  }
}
