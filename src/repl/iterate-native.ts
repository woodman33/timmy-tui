/**
 * /iterate scad and /iterate freecad in the REPL (round R4, helper H33): what the two native flows share. Each flow has
 * its own id (f + 8 hex) and runs beside the tray and Blender flows (src/repl/iterate.ts parses the line and hands it
 * here); one flow of any kind at a time runs in a project, since an agent's before/after comparison covers all of it.
 *
 * Shared here: the agent's route (a local, free one only: Qwen Code on a loopback endpoint, or Codex's local route,
 * codex exec --oss, whose model this machine's Ollama must already list; never a cloud model, never --paid), the
 * agent's step (/agent's own start: its job, its snapshot before and after, its sealed result), the Python syntax check
 * (an AST parse by this machine's python3, nothing run), keeping a job's raw output with the flow, the record
 * (results/flows/<flow-id>.json) and its `flow` receipt with the child receipts, and stopping: /stop <flow-id> stops
 * the step that runs (the agent's job, the app's job, the readback's job; the syntax check's python3 through the
 * flow's abort); /stop all and the REPL's end stop every flow so none starts a next step.
 *
 * Each target's own steps are in src/repl/iterate-scad.ts and src/repl/iterate-freecad.ts. The structure mirrors the
 * Blender flow (src/repl/iterate-blender.ts), which another helper edits this round, so nothing is factored out of it.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import type { JobRecord } from '../jobs/index.js';
import { AGENTS, AGENTS_DIR, agentBin, planAgent, type AgentName, type AgentPlan, type AgentRunRecord } from '../code-agents/index.js';
import { codexLocalPreflight } from '../code-agents/codex-local.js';
import { projectId, resolveInside } from '../project/index.js';
import { flowRecordPath, flowWorkDir, writeProjectJson, type FlowOutcome } from '../flows/iterate.js';
import { parseSyntaxOutput, SYNTAX_CHECK_CODE, SYNTAX_TIMEOUT_MS, type NativeFlowRecordBase, type NativeTarget, type SyntaxCheck } from '../flows/iterate-native.js';
import type { IterateDeps } from './iterate.js';
import type { Segment } from '../term/theme.js';
import type { ReceiptInput } from '../utils/receipts.js';

export type Line = Segment[];

/** `/iterate scad <model.scad> "<instruction>"` or `/iterate freecad <script.py> "<instruction>"`, parsed (src/repl/iterate.ts). */
export interface NativeIterateRequest { recipe: NativeTarget; file: string; instruction: string; agent: AgentName; model?: string }

/** A native flow while it runs: its record, its step, and the jobs of its steps. */
export interface NativeRun<R extends NativeFlowRecordBase> {
  id: string;
  root: string;
  project: string;
  record: R;
  abort: AbortController;
  step: string;
  agentJob?: string;
  agentRecord?: AgentRunRecord;
  /** the app's job (OpenSCAD's, FreeCAD's) */
  nativeJob?: string;
  readbackJob?: string;
  done?: Promise<R>;
  receipt?: string;
  recordFile?: string;
}

export type Started<R extends NativeFlowRecordBase> = { ok: true; flow: NativeRun<R>; lines: Line[] } | { ok: false; error: string; lines: Line[] };
export type Refusal = { ok: false; error: string; role: Segment['role'] };

export const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
export const short = (s: string | null | undefined): string => (s ? s.slice(0, 12) : '?');
export const within = <T>(p: Promise<T>, ms: number): Promise<T | undefined> =>
  Promise.race([p, new Promise<undefined>((resolve) => { setTimeout(() => resolve(undefined), ms).unref?.(); })]);
export const relTo = (root: string, abs: string): string => path.relative(root, abs).split(path.sep).join('/');
export const exitWords = (j: JobRecord): string => j.error ?? (j.signal ? `ended by ${j.signal}` : `exited ${j.exitCode ?? '?'}`);

/**
 * Keeps bytes in the project (the flow's folder in .timmy, which the agent's comparison does not look into), written
 * once and read-only, never through a link that leads out of the project; its project-relative path, or undefined when
 * it could not be kept (the flow goes on without it).
 */
export function keepBytes(root: string, rel: string, bytes: Buffer): string | undefined {
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

export abstract class NativeFlows<R extends NativeFlowRecordBase> {
  protected readonly running = new Map<string, NativeRun<R>>();
  /** a flow being started in a project (its agent is starting), by the project's folder: it holds the project already */
  protected readonly starting = new Map<string, string>();

  /** `busyElsewhere`: a flow of another kind running in a project (one flow at a time runs in a project, of any kind). */
  constructor(protected readonly d: IterateDeps, protected readonly busyElsewhere: (root: string) => { id: string; step: string } | undefined) {}

  /** 'scad' or 'freecad': the record's target and the receipt's subject. */
  abstract readonly target: NativeTarget;
  /** The app's name in sentences ("OpenSCAD did not run"). */
  abstract readonly app: string;
  /** The step the app's job runs in ('openscad', 'freecad'). */
  abstract readonly appStep: string;
  /** The usage line. */
  abstract readonly usage: string;
  /** The file the agent was asked to change, with its sha256 before and after: the flow receipt's source. */
  protected abstract flowSources(r: R): unknown[];
  /** The child receipts, in their order (the agent's, the app's, the readback's). */
  protected abstract childReceipts(r: R): string[];
  /** What the flow's end says after its first line: the measurements, who made them, DOCTRINE §15. */
  protected abstract measuredLines(r: R): Line[];
  /** A running flow's words for /iterate's list ("scad box.scad"). */
  protected abstract what(r: R): string;

  protected get sep(): string { return ` ${this.d.glyphs.sep} `; }
  protected say(text: string, role: Segment['role'] = 'secondary'): Line[] { return [[{ text: `  ${text}`, role }]]; }
  protected refuse(error: string, role: Segment['role'] = 'failure', more: Line[] = []): Started<R> { return { ok: false, error, lines: [...this.say(error, role), ...more] }; }

  /** The flows of this kind this REPL is running (their ids). */
  get active(): string[] { return [...this.running.keys()]; }
  has(id: string): boolean { return this.running.has(id); }
  /** The flow of this kind running (or being started) in this project, if one is. */
  runningIn(root: string): { id: string; step: string } | undefined {
    const f = [...this.running.values()].find((x) => x.root === root);
    if (f) return { id: f.id, step: f.step };
    const starting = this.starting.get(root);
    return starting ? { id: starting, step: 'prepare' } : undefined;
  }

  /** /iterate's rows for the flows of this kind running in this project. */
  runningRows(root: string): Line[] {
    return [...this.running.values()].filter((f) => f.root === root).map((f) => [{ text: `    ${this.d.glyphs.bullet} ` }, { text: f.id, role: 'strong' as const },
      { text: `  running: the ${f.step} step${this.sep}/stop ${f.id}${this.sep}${this.what(f.record)}: ${this.d.scrub(f.record.instruction, root).slice(0, 50)}`, role: 'secondary' as const }]);
  }

  // ── before the agent ───────────────────────────────────────────────────────────

  /**
   * The agent's route, before anything is written: a local, free one, or why not. `--agent codex` is Codex's local
   * route (codex exec --oss), under Qwen Code's endpoint rule; any other agent, a remote endpoint or a cloud model is
   * refused, and there is no --paid.
   */
  protected route(req: NativeIterateRequest, env: NodeJS.ProcessEnv, root: string): { ok: true; local: { local?: true }; plan: AgentPlan } | Refusal {
    const info = AGENTS[req.agent];
    const bin = agentBin(req.agent, env, this.d.onPath);
    if (!bin) return { ok: false, role: 'estimate', error: `${info.title} is not on PATH (${info.bin}); /tools says how to install it. Nothing was started.` };
    if (!env.TIMMY_AGENT_MODEL?.trim()) return { ok: false, role: 'failure', error: `Name the local model: ${this.usage.replace('[--model <local model>]', '--model <a model your local endpoint serves, from ollama list>')}, or set TIMMY_AGENT_MODEL. Nothing was started.` };
    const local = req.agent === 'codex' ? { local: true as const } : {};
    const planned = planAgent(req.agent, req.instruction, { env, paid: false, run: 'a00000000', bin, ...local, root });
    if (!planned.ok) {
      const why = planned.error.replace(/\s*To run it anyway:.*$/, '');
      return planned.refused === 'paid' ? { ok: false, role: 'estimate', error: `${why} /iterate runs only a local, free route, and has no --paid.` } : { ok: false, role: 'failure', error: why };
    }
    return { ok: true, local, plan: planned.plan };
  }

  /**
   * Codex's local route: its model must already be in this machine's Ollama (codex --oss would download it). Why not, or
   * undefined. The project is held while it is asked (the answer is awaited), so no second flow starts meanwhile.
   */
  protected async preflight(plan: AgentPlan, root: string, id: string): Promise<string | undefined> {
    if (!plan.oss) return undefined;
    this.starting.set(root, id);
    let ready: Awaited<ReturnType<typeof codexLocalPreflight>>;
    try { ready = await codexLocalPreflight(plan.oss); } finally { this.starting.delete(root); }
    return ready.ok ? undefined : this.d.scrub(ready.error, root);
  }

  /** The flow running in this project, of any kind. */
  protected busy(root: string): { id: string; step: string } | undefined { return this.runningIn(root) ?? this.busyElsewhere(root); }

  /** Starts the agent through /agent's own start, holding the project meanwhile, so no second flow starts. */
  protected async startAgent(id: string, req: NativeIterateRequest, task: string, o: { root: string; project: string; env: NodeJS.ProcessEnv; local: { local?: true } }): Promise<Awaited<ReturnType<IterateDeps['startAgent']>>> {
    this.starting.set(o.root, id);
    try { return await this.d.startAgent(req.agent, task, { paid: false, ...o.local, root: o.root, project: o.project, env: o.env }); } finally { this.starting.delete(o.root); }
  }

  /** The agent's part of the record, from its start. */
  protected agentPart(s: Extract<Awaited<ReturnType<IterateDeps['startAgent']>>, { ok: true }>): NonNullable<NativeFlowRecordBase['agent']> {
    return {
      run: s.run, agent: s.plan.agent, version: s.version, route: s.plan.charge, where: s.plan.where, model: s.plan.model, job: s.job.id,
      result: `${AGENTS_DIR}/${s.run}/result.json`, progress: `${AGENTS_DIR}/${s.run}/progress.log`,
    };
  }

  /** Registers the flow, saves its state and runs its steps (`steps`), then its record. */
  protected launch(f: NativeRun<R>, steps: (f: NativeRun<R>) => Promise<void>): void {
    this.running.set(f.id, f);
    this.saveState(f);
    f.done = (async () => {
      try {
        await steps(f);
        if (f.record.outcome === 'running') this.end(f, 'failed', 'record', 'the flow ended without a verdict');
      } catch (e) {
        this.end(f, this.stopped(f) ? 'cancelled' : 'failed', f.step === 'done' ? 'record' : f.step, `the flow could not go on: ${this.d.scrub(e instanceof Error ? e.message : String(e), f.root)}`);
      }
      return this.finish(f);
    })().finally(() => { this.running.delete(f.id); });
  }

  // ── the steps ──────────────────────────────────────────────────────────────────

  /** Ends the flow (once): its outcome, the step it ended in, and why. */
  protected end(f: NativeRun<R>, outcome: Exclude<FlowOutcome, 'running'>, step: string, why: string): void {
    if (f.record.outcome !== 'running') return;
    f.record.outcome = outcome;
    f.record.ended_in = step;
    f.record.why = why;
  }

  protected stopped(f: NativeRun<R>): boolean { return f.abort.signal.aborted; }

  protected note(f: NativeRun<R>, text: string, role: Segment['role'] = 'secondary'): void {
    this.d.notify([{ text: `  ${this.d.glyphs.bullet} ` }, { text: f.id, role: 'strong' }, { text: `  ${text}`, role }]);
  }

  protected saveState(f: NativeRun<R>): void {
    writeProjectJson(f.root, `${flowWorkDir(f.id)}/state.json`, { ...f.record, step: f.step });
  }

  /** A job's raw output (stdout and stderr as it logged them), copied into the flow's folder; its place, sha256 and size. */
  protected keepLog(f: NativeRun<R>, job: JobRecord, name: string): { rel: string; sha256: string; bytes: number } | undefined {
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

  /** The agent's step: its job's end and its sealed result (what it changed, its cost and receipt). */
  protected async agentStep(f: NativeRun<R>): Promise<void> {
    f.step = 'agent';
    const job = await this.d.jobs.done(f.agentJob!);
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
    if (this.stopped(f) || a.outcome === 'cancelled' || job.state === 'cancelled') return this.end(f, 'cancelled', 'agent', `stopped with /stop during the agent step; ${this.app} did not run${kept}`);
    if (a.outcome !== 'completed') return this.end(f, 'failed', 'agent', `the agent run ended ${a.outcome}${a.why ? `: ${a.why}` : ''}; ${this.app} did not run${kept}`);
    this.saveState(f);
  }

  /**
   * An AST parse of a script's bytes by this machine's python3 (`python3 -I -c …`, the bytes on stdin): nothing in the
   * script runs. No python3, or none that answers, is "not checked", with the reason.
   */
  protected syntax(f: NativeRun<R>, bytes: Buffer, rel: string): Promise<SyntaxCheck> {
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
        done({ checked: false, why: this.stopped(f) ? 'stopped with /stop' : `python3 gave no answer (${signal ? `ended by ${signal}` : `exit ${code}`})` });
      });
      child.stdin?.on('error', () => { /* it ended before reading all of it: its answer, or none, says what happened */ });
      child.stdin?.end(bytes);
    });
  }

  // ── the record ─────────────────────────────────────────────────────────────────

  /** The record (results/flows/<flow-id>.json), the flow receipt binding its sha256 and the child receipts, the notice. */
  protected finish(f: NativeRun<R>): R {
    f.step = 'record';
    const rec = f.record;
    rec.ended_at = new Date().toISOString();
    rec.child_receipts = this.childReceipts(rec);
    const w = writeProjectJson(f.root, flowRecordPath(f.id), rec);
    const status = rec.outcome === 'succeeded' ? 'ok' as const : rec.outcome === 'cancelled' ? 'cancelled' as const : 'failed' as const;
    const cost = rec.agent?.cost_usd;
    let receipt: string | undefined;
    try {
      const input: ReceiptInput = {
        kind: 'flow', subject: `flow · iterate · ${this.target} · ${f.id} · ${rec.outcome}`, policy: 'human-gated', status,
        project: f.project, project_id: projectId(f.root),
        prompt_hash: `sha256:${sha(rec.instruction)}`,
        ...(w.ok ? { outputs: [{ path: w.path, sha256: w.sha256, bytes: w.bytes }] } : { discrepancies: [`the flow record could not be written: ${this.d.scrub(w.error, f.root)}`] }),
        sources: this.flowSources(rec),
        ...(rec.child_receipts.length ? { child_receipts: rec.child_receipts } : {}),
        // The agent's cost as its own receipt sealed it: 0 on a local endpoint; unknown is never written as 0.
        ...(typeof cost === 'number' ? { cost_usd: cost } : cost === null ? { cost_measured: false } : {}),
      };
      receipt = this.d.seal(input);
    } catch { receipt = undefined; }
    f.receipt = receipt;
    if (w.ok) f.recordFile = w.path;
    this.saveState(f);
    f.step = 'done';
    for (const l of this.endLines(f, w.ok ? w.path : undefined, receipt)) this.d.notify(l);
    return rec;
  }

  private endLines(f: NativeRun<R>, file: string | undefined, receipt: string | undefined): Line[] {
    const g = this.d.glyphs;
    const rec = f.record;
    const ok = rec.outcome === 'succeeded';
    const tail = `${file ? `${this.sep}record ${file}` : `${this.sep}the record could not be written`}${receipt ? `${this.sep}receipt ${receipt}` : ''}`;
    return [[{ text: `  ${ok ? g.ok : rec.outcome === 'cancelled' ? ' ' : g.fail} `, role: ok || rec.outcome === 'cancelled' ? undefined : 'failure' },
      { text: `${f.id} ${rec.outcome}`, role: ok || rec.outcome === 'cancelled' ? 'strong' : 'failure' }, { text: `: ${rec.why ?? ''}${tail}`, role: 'secondary' }], ...this.measuredLines(rec)];
  }

  // ── stopping ─────────────────────────────────────────────────────────────────

  /** `/stop <flow-id>`: stops the step that runs, waits for the record, and says what happened. */
  async stop(id: string): Promise<Line[]> {
    const f = this.running.get(id);
    if (!f) return this.say(`No flow ${id} is running in this REPL: /iterate lists the flows.`);
    const step = f.step;
    f.abort.abort();
    if (step === 'agent' && f.agentJob) await this.d.jobs.stop(f.agentJob);
    else if (step === this.appStep && f.nativeJob) await this.d.jobs.stop(f.nativeJob);
    else if (step === 'readback' && f.readbackJob) await this.d.jobs.stop(f.readbackJob);
    const rec = f.done ? await within(f.done, 60_000) : undefined;
    if (!rec) return this.say(`${id}: stopping (it was in the ${step} step); its record is not written yet: /iterate`, 'estimate');
    return [[{ text: `  ${id} ${rec.outcome}`, role: rec.outcome === 'cancelled' ? 'strong' : 'failure' },
      { text: `  ${rec.why ?? ''}${f.recordFile ? `${this.sep}record ${f.recordFile}` : ''}${f.receipt ? `${this.sep}receipt ${f.receipt}` : ''}`, role: 'secondary' }]];
  }

  /**
   * /stop all and the REPL's end: every flow of this kind is marked stopped, so none starts a next step (the jobs
   * themselves are stopped by the caller, as this REPL's jobs). How many were running, their records to wait for, and
   * how each ended.
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

  /** The records of the flows of this kind running now, to wait for. */
  pending(): Array<Promise<unknown>> { return [...this.running.values()].map((f) => f.done ?? Promise.resolve()); }
}
