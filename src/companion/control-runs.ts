/**
 * The integrated candidate's checklist, B1–B8 (the operator's order of 2026-10-27): the Control Room starts, follows, stops
 * and inspects a code-agent run, through the existing adapter only — `timmy act "/agent <name> …" --wait --json --project
 * <the run's workspace>` (src/ops/act.ts → the Workspace's startAgentRun → planAgent and its harness: OpenHands' container,
 * or Qwen Code). Two harnesses, each on a model in this machine's Ollama; nothing else starts here.
 *
 * - Propose: the plan the adapter itself makes (planAgent: its model, endpoint, charge, wall time), with OpenHands' own
 *   preflight (its worker, Docker's daemon, its image, the model in this machine's Ollama) and Qwen Code's (the model in
 *   that Ollama). Nothing is written or started. The proposal is kept here for PROPOSAL_MS and is used once, by the same
 *   principal for the same project.
 * - Approve and start (the person's press on the page): the run's workspace is a copy of the project (no .git, .timmy or
 *   node_modules) under the principal's Timmy home, with its own receipt store pinned in it, so the project itself is not
 *   changed by the run. The launcher is the act process, detached; its stdout (the end's JSON) and stderr (its progress
 *   lines) are files beside the run's record.
 * - Stop: SIGTERM to the act process. act stops what it started through the normal stop path (OpenHands' container first)
 *   and exits 3. The record says stopped only because act's own end says so.
 * - Inspect: act's end (its operation, outcome, exit, receipts), the agent's result.json in the workspace (the files it
 *   changed, its final message, its outcome), and each changed file's diff against the project (git diff --no-index).
 * - Seal: once, at the end, a control-run receipt in the PROJECT's chain (appendReceipt, the single-writer path) naming the
 *   harness, model, operation, job, the agent's receipt in the workspace's store, how it ended and what it changed.
 * - Interrupted: an act process gone without its end's JSON reads as interrupted; Recover runs `timmy act /recover` in the
 *   workspace, which settles what that act left, and the run is read again.
 *
 * ASSUMED, not checked here: that the act process's pid is not reused by another process between two reads while the
 * companion that started it is gone (with the companion running, its exit is seen directly).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import type express from 'express';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENTS, AGENTS_DIR, DEFAULT_BASE_URL, agentBin, planAgent, type AgentName, type AgentRunRecord } from '../code-agents/index.js';
import { ollamaListed } from '../code-agents/openhands-run.js';
import { projectId } from '../project/index.js';
import { realOnPath } from '../repl/center.js';
import { timmyHome } from '../setup/home.js';
import { scrubHomes } from '../utils/home-scrub.js';
import { appendReceipt } from '../utils/receipts.js';

type Env = Record<string, string | undefined>;

export const CONTROL_RUN_SCHEMA = 'timmy.control-run/1' as const;
/** The harnesses the Control Room starts in this pass (the order: OpenHands and one other already supported). */
export const CONTROL_HARNESSES = ['openhands', 'qwen'] as const satisfies readonly AgentName[];
export type ControlHarness = (typeof CONTROL_HARNESSES)[number];
export const PROPOSAL_MS = 10 * 60_000;
export const TASK_MAX = 4000;
/** the run's time limit, minutes: what the page offers and the most it takes */
export const LIMIT_DEFAULT_MIN = 10;
export const LIMIT_MAX_MIN = 60;
/** a workspace copy larger than this is refused (the project is too big to copy for a run) */
export const COPY_MAX_BYTES = 300 * 1024 * 1024;
export const COPY_MAX_FILES = 30_000;
const COPY_SKIP = new Set(['.git', '.timmy', 'node_modules']);
const TAIL_MAX = 40;
const DIFF_FILES_MAX = 20;
const DIFF_BYTES_MAX = 120 * 1024;
const MODEL_NAME = /^[A-Za-z0-9._:/+-]{1,120}$/;
const RUN_ID = /^c[0-9a-f]{8}$/;

/** Who asks, about which project, with which environment (the principal's: a signed-in user's own, else the operator's). */
export interface ControlScope {
  principal: string;
  project: { name: string; root: string };
  env: Env;
}

export type ControlState = 'running' | 'stopping' | 'succeeded' | 'failed' | 'stopped' | 'refused' | 'interrupted';

/** One run, as its record keeps it (run.json beside its workspace). */
export interface ControlRunRecord {
  schema: typeof CONTROL_RUN_SCHEMA;
  id: string;
  principal: string;
  project: { id: string; name: string };
  harness: ControlHarness;
  title: string;
  model: string;
  endpoint: 'local';
  where: string;
  charge: string;
  wall_time: string;
  task: string;
  task_sha256: string;
  /** the proposal the person approved: its id and the hash of what it showed */
  approved: { proposal: string; plan_sha256: string; at: string };
  workspace: { files: number; bytes: number; skipped: string[] };
  started_at: string;
  pid: number | null;
  state: ControlState;
  stop?: { asked_at: string; by: string };
  ended_at?: string;
  /** act's own end (its JSON): null until it printed one */
  act?: { operation: string | null; outcome: string; exit_code: number; why: string; runs: Array<{ kind: string; id: string }>; receipts: Array<{ id: string; kind: string; status?: string }> } | null;
  /** how the act process ended, as the companion saw it (or did not) */
  exit?: { code: number | null; signal: string | null; seen: boolean };
  /** the project's receipt for this run (its id), sealed once */
  receipt?: string;
  why?: string;
}

const sha = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');
const now = (): string => new Date().toISOString();
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split('\n')[0];

/** Where a principal's runs of a project live (under that principal's Timmy home). */
export function runsDir(scope: ControlScope): string {
  return path.join(timmyHome(scope.env), 'control-runs', projectId(scope.project.root));
}
const runDirOf = (scope: ControlScope, id: string): string => path.join(runsDir(scope), id);
const recordPath = (dir: string): string => path.join(dir, 'run.json');

function readRecord(dir: string): ControlRunRecord | null {
  try { const r = JSON.parse(fs.readFileSync(recordPath(dir), 'utf8')) as ControlRunRecord; return r && r.schema === CONTROL_RUN_SCHEMA ? r : null; } catch { return null; }
}
function writeRecord(dir: string, r: ControlRunRecord): void {
  const tmp = `${recordPath(dir)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(r, null, 1)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, recordPath(dir));
}

/** The words a person reads for a harness (AGENTS' title). */
export const harnessTitle = (h: ControlHarness): string => AGENTS[h].title;
const isHarness = (v: unknown): v is ControlHarness => typeof v === 'string' && (CONTROL_HARNESSES as readonly string[]).includes(v);

// ── what each harness needs here ────────────────────────────────────────────────────────────────────────────────────────

export interface HarnessState {
  id: ControlHarness;
  title: string;
  /** its program here (Qwen Code's qwen; OpenHands' docker) */
  found: boolean;
  /** what it needs before it can start (absent: nothing known to be missing until a proposal is checked) */
  needs?: string;
}

export interface ControlDeps {
  /** test seam: the fetch the Ollama check uses */
  fetch?: typeof fetch;
  /** test seam: OpenHands' preflight (its worker, docker, its image, the model): the Workspace's own by default */
  openhandsPreflight?: (o: { env: Env; bin: string; model: string; root: string }) => Promise<{ ok: true; version: string } | { ok: false; error: string }>;
  /** the command that is `timmy` (default: this package's dist/timmy.js under this node) */
  timmy?: string[];
  now?: () => number;
}

function onPathOf(env: Env): (cmd: string) => string | null { return (cmd) => realOnPath(cmd, env); }

export function harnessStates(env: Env): HarnessState[] {
  return CONTROL_HARNESSES.map((h) => {
    const bin = agentBin(h, env, onPathOf(env));
    return {
      id: h, title: harnessTitle(h), found: Boolean(bin),
      ...(bin ? {} : { needs: h === 'openhands' ? 'docker is not on PATH here (OpenHands runs in a container)' : 'qwen is not on PATH here (Qwen Code is not installed)' }),
    };
  });
}

/** The models this machine's Ollama lists, without its cloud ones (a cloud tag runs remotely, and may cost money). */
export async function localModels(env: Env, f: typeof fetch = fetch): Promise<{ ok: true; models: string[] } | { ok: false; error: string }> {
  const base = (env.TIMMY_AGENT_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/v1\/?$/, '').replace(/\/$/, '');
  try {
    const res = await f(`${base}/api/tags`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return { ok: false, error: `the Ollama at ${new URL(base).host} answered ${res.status}` };
    const body = await res.json() as { models?: Array<{ name?: unknown }> };
    const names = (body.models ?? []).map((m) => m?.name).filter((n): n is string => typeof n === 'string');
    return { ok: true, models: names.filter((n) => !/(^|[:-])cloud\b/i.test(n)).sort() };
  } catch (e) { return { ok: false, error: `no Ollama answered at ${base.replace(/^https?:\/\//, '')} (${msg(e)})` }; }
}

// ── propose ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ControlProposal {
  id: string;
  harness: ControlHarness;
  title: string;
  model: string;
  endpoint: 'local';
  where: string;
  charge: string;
  wall_time: string;
  task: string;
  /** what it works on: a copy of the project, made at the start */
  workspace: string;
  /** what the run may do, in words */
  may: string[];
  preflight: string;
  expires_at: string;
  plan_sha256: string;
}

interface Kept { p: ControlProposal; principal: string; projectRoot: string; until: number }

export type Refusal = { ok: false; status: number; refused: 'usage' | 'setup' | 'paid' | 'missing' | 'unknown' | 'busy'; error: string };

export class ControlRuns {
  private readonly proposals = new Map<string, Kept>();
  /** the act processes this companion started, by run id (their exit is seen here) */
  private readonly children = new Map<string, ChildProcess>();

  constructor(private readonly d: ControlDeps = {}) {}

  private t(): number { return this.d.now ? this.d.now() : Date.now(); }

  /** The command that is `timmy`: this package's own entry under this node (dist/src/companion → dist/timmy.js). */
  private timmy(): string[] {
    if (this.d.timmy) return this.d.timmy;
    return [process.execPath, fileURLToPath(new URL('../../timmy.js', import.meta.url))];
  }

  async propose(scope: ControlScope, body: { harness?: unknown; task?: unknown; model?: unknown; limit?: unknown }): Promise<{ ok: true; proposal: ControlProposal } | Refusal> {
    if (!isHarness(body.harness)) return { ok: false, status: 400, refused: 'usage', error: `Choose ${CONTROL_HARNESSES.map(harnessTitle).join(' or ')}: the Control Room starts these two in this revision. Nothing was started.` };
    const h = body.harness;
    const task = typeof body.task === 'string' ? body.task.trim() : '';
    if (!task) return { ok: false, status: 400, refused: 'usage', error: `Say what ${harnessTitle(h)} should do. Nothing was started.` };
    if (task.length > TASK_MAX) return { ok: false, status: 400, refused: 'usage', error: `The task is ${task.length} characters; at most ${TASK_MAX} are taken. Nothing was started.` };
    const model = typeof body.model === 'string' ? body.model.trim() : '';
    if (!MODEL_NAME.test(model)) return { ok: false, status: 400, refused: 'usage', error: 'Choose a model this machine\'s Ollama lists. Nothing was started.' };
    const limit = body.limit === undefined || body.limit === '' ? LIMIT_DEFAULT_MIN : Number(body.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > LIMIT_MAX_MIN) return { ok: false, status: 400, refused: 'usage', error: `The time limit is whole minutes, 1 to ${LIMIT_MAX_MIN}. Nothing was started.` };
    const env = this.childEnv(scope, model, `${limit}m`);
    const bin = agentBin(h, env, onPathOf(env));
    if (!bin) return { ok: false, status: 409, refused: 'missing', error: `Needs setup: ${harnessStates(env).find((s) => s.id === h)?.needs ?? 'its program is not here'}. Nothing was started.` };
    const planned = planAgent(h, task, { env, paid: false, run: 'a00000000', bin, ...(h === 'openhands' ? { local: true, root: scope.project.root } : {}) });
    if (!planned.ok) return { ok: false, status: 409, refused: planned.refused === 'usage' ? 'usage' : planned.refused, error: planned.error };
    const plan = planned.plan;
    if (plan.endpoint !== 'local') return { ok: false, status: 409, refused: 'paid', error: `${plan.where} is not on this machine, so it may cost money: the Control Room starts local runs only. Nothing was started.` };
    let preflight: string;
    if (h === 'openhands') {
      const pre = await (this.d.openhandsPreflight ?? defaultOpenHandsPreflight)({ env, bin, model, root: scope.project.root });
      if (!pre.ok) return { ok: false, status: 409, refused: 'setup', error: scrubHomes(pre.error, env as NodeJS.ProcessEnv) };
      preflight = `ready: ${pre.version}; the model is listed by this machine's Ollama`;
    } else {
      const listed = await ollamaListed(env.TIMMY_AGENT_BASE_URL?.trim() || DEFAULT_BASE_URL, model, this.d.fetch ? { fetch: this.d.fetch } : {});
      if (!listed.ok) return { ok: false, status: 409, refused: 'setup', error: listed.error };
      preflight = `ready: qwen is on PATH; the model is listed by this machine's Ollama`;
    }
    this.sweep();
    const id = `p${randomBytes(6).toString('hex')}`;
    const may = h === 'openhands'
      ? ['edit the files of its copy of the project, inside its container (no browser; the terminal and the file editor only)', 'reach this machine\'s Ollama, and the network, from its container']
      : ['edit the files of its copy of the project (edits are approved automatically: --approval-mode auto-edit)', 'not run shell commands: Qwen Code asks for them, and a run here has no one to ask, so they are refused'];
    const base = {
      harness: h, title: harnessTitle(h), model, endpoint: 'local' as const, where: plan.where, charge: plan.charge, wall_time: plan.wallTime, task,
      workspace: `a copy of ${scope.project.name}, made when you approve (without .git, .timmy and node_modules); ${scope.project.name} itself is not changed`,
      may: [...may, 'nothing that costs money: its model is this machine\'s'], preflight,
    };
    const plan_sha256 = sha(JSON.stringify(base));
    const p: ControlProposal = { id, ...base, expires_at: new Date(this.t() + PROPOSAL_MS).toISOString(), plan_sha256 };
    this.proposals.set(id, { p, principal: scope.principal, projectRoot: path.resolve(scope.project.root), until: this.t() + PROPOSAL_MS });
    return { ok: true, proposal: p };
  }

  private sweep(): void { const t = this.t(); for (const [k, v] of this.proposals) if (v.until <= t) this.proposals.delete(k); }

  /** The act process's environment: the principal's, with the run's model and wall time, and no keys of Timmy's own. */
  private childEnv(scope: ControlScope, model: string, wall: string): Env {
    const env: Env = {};
    for (const [k, v] of Object.entries(scope.env)) {
      if (v === undefined) continue;
      if (/(API_KEY|_TOKEN|_SECRET|PASSWORD|SESSION)$/i.test(k)) continue; // a local run is given no key of Timmy's
      env[k] = v;
    }
    delete env.TIMMY_OPERATION; // a run here is its own operation, never one the companion's process is in
    delete env.TIMMY_STORE;
    env.TIMMY_HOME = timmyHome(scope.env);
    env.TIMMY_AGENT_MODEL = model;
    env.TIMMY_AGENT_WALL_TIME = wall;
    return env;
  }

  // ── approve and start ─────────────────────────────────────────────────────────────────────────────────────────────────

  start(scope: ControlScope, body: { proposal?: unknown }): { ok: true; run: ControlRunView } | Refusal {
    this.sweep();
    const pid = typeof body.proposal === 'string' ? body.proposal : '';
    const kept = this.proposals.get(pid);
    if (!kept) return { ok: false, status: 404, refused: 'unknown', error: 'That proposal is not here (it was used, or it is more than 10 minutes old): review the run again. Nothing was started.' };
    if (kept.principal !== scope.principal || kept.projectRoot !== path.resolve(scope.project.root)) return { ok: false, status: 404, refused: 'unknown', error: 'That proposal is not here. Nothing was started.' };
    this.proposals.delete(pid); // used once
    const p = kept.p;
    const id = `c${randomBytes(4).toString('hex')}`;
    const dir = runDirOf(scope, id);
    const work = path.join(dir, 'work');
    let copied: { files: number; bytes: number; skipped: string[] };
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      copied = copyProject(scope.project.root, work);
      // the workspace's own receipt store, pinned in it (src/utils/receipts.ts rootStoreDir, pass 1): the agent's receipts
      // are sealed there, never into the project's or a folder above it
      fs.mkdirSync(path.join(work, '.timmy'), { recursive: true });
      fs.writeFileSync(path.join(work, '.timmy', 'store-pin'), path.join(dir, 'receipts'));
      fs.mkdirSync(path.join(dir, 'receipts'), { recursive: true });
    } catch (e) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* nothing left to say */ }
      return { ok: false, status: 409, refused: 'setup', error: `The run's copy of ${scope.project.name} could not be made: ${scrubHomes(msg(e), scope.env as NodeJS.ProcessEnv)}. Nothing was started.` };
    }
    const env = this.childEnv(scope, p.model, p.wall_time);
    const line = p.harness === 'openhands' ? `/agent openhands --local ${p.task}` : `/agent qwen ${p.task}`;
    const [cmd, ...pre] = this.timmy();
    const out = fs.openSync(path.join(dir, 'act.out'), 'w', 0o600);
    const err = fs.openSync(path.join(dir, 'act.err'), 'w', 0o600);
    let child: ChildProcess;
    try {
      child = spawn(cmd, [...pre, 'act', line, '--wait', '--json', '--project', work], { cwd: work, env: env as NodeJS.ProcessEnv, stdio: ['ignore', out, err], detached: true });
    } catch (e) {
      fs.closeSync(out); fs.closeSync(err);
      return { ok: false, status: 500, refused: 'setup', error: `timmy act could not start: ${msg(e)}. Nothing was started.` };
    }
    fs.closeSync(out); fs.closeSync(err);
    const rec: ControlRunRecord = {
      schema: CONTROL_RUN_SCHEMA, id, principal: scope.principal, project: { id: projectId(scope.project.root), name: scope.project.name },
      harness: p.harness, title: p.title, model: p.model, endpoint: 'local', where: p.where, charge: p.charge, wall_time: p.wall_time,
      task: p.task, task_sha256: sha(p.task), approved: { proposal: p.id, plan_sha256: p.plan_sha256, at: now() },
      workspace: copied, started_at: now(), pid: child.pid ?? null, state: 'running',
    };
    writeRecord(dir, rec);
    this.children.set(id, child);
    child.on('error', (e) => { this.children.delete(id); this.settle(scope, id, { code: null, signal: null, seen: true }, `timmy act could not run: ${msg(e)}`); });
    child.on('exit', (code, signal) => { this.children.delete(id); this.settle(scope, id, { code, signal, seen: true }); });
    child.unref();
    return { ok: true, run: this.view(scope, rec) };
  }

  // ── stop and recover ──────────────────────────────────────────────────────────────────────────────────────────────────

  stop(scope: ControlScope, id: string, by = 'the Control Room\'s Stop'): { ok: true; run: ControlRunView } | Refusal {
    const dir = this.own(scope, id);
    if (!dir) return { ok: false, status: 404, refused: 'unknown', error: 'No such run in this project.' };
    const rec = this.read(scope, id)!;
    if (rec.state !== 'running' && rec.state !== 'stopping') return { ok: true, run: this.view(scope, rec) };
    if (!rec.pid || !alive(rec.pid)) return { ok: true, run: this.view(scope, this.read(scope, id)!) };
    try { process.kill(rec.pid, 'SIGTERM'); } catch (e) { return { ok: false, status: 409, refused: 'setup', error: `The stop could not be sent: ${msg(e)}` }; }
    rec.state = 'stopping';
    rec.stop = { asked_at: now(), by };
    writeRecord(dir, rec);
    return { ok: true, run: this.view(scope, rec) };
  }

  /** A run left interrupted: `timmy act /recover` in its workspace settles what that act left; then it is read again. */
  recover(scope: ControlScope, id: string): { ok: true; run: ControlRunView; said: string[] } | Refusal {
    const dir = this.own(scope, id);
    if (!dir) return { ok: false, status: 404, refused: 'unknown', error: 'No such run in this project.' };
    const rec = this.read(scope, id)!;
    if (rec.state !== 'interrupted') return { ok: false, status: 409, refused: 'busy', error: `This run is ${rec.state}: only an interrupted run is recovered.` };
    const [cmd, ...pre] = this.timmy();
    const r = spawnSync(cmd, [...pre, 'act', '/recover', '--json', '--project', path.join(dir, 'work')], { cwd: path.join(dir, 'work'), env: this.childEnv(scope, rec.model, rec.wall_time) as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 60_000 });
    const said = String(r.stderr ?? '').split('\n').filter(Boolean).slice(-12).map((l) => scrubHomes(l, scope.env as NodeJS.ProcessEnv));
    let end: { lines?: string[]; exit_code?: number } = {};
    try { end = JSON.parse(String(r.stdout ?? '').trim().split('\n').pop() ?? '{}'); } catch { /* none */ }
    const recovered = this.read(scope, id)!;
    recovered.why = `recovered (timmy act /recover exited ${r.status ?? 'without an exit code'}): ${(end.lines ?? []).slice(-2).join(' ').slice(0, 300) || 'it said nothing more'}`;
    writeRecord(dir, recovered);
    this.seal(scope, dir, recovered);
    return { ok: true, run: this.view(scope, this.read(scope, id)!), said };
  }

  // ── read ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

  /** A run's folder when it is this principal's and this project's; null otherwise (another's is never named). */
  private own(scope: ControlScope, id: string): string | null {
    if (!RUN_ID.test(id)) return null;
    const dir = runDirOf(scope, id);
    const r = readRecord(dir);
    return r && r.principal === scope.principal && r.project.id === projectId(scope.project.root) ? dir : null;
  }

  /** The record, settled now when its act process is gone without the companion having seen it end. */
  read(scope: ControlScope, id: string): ControlRunRecord | null {
    const dir = this.own(scope, id);
    if (!dir) return null;
    const r = readRecord(dir)!;
    if ((r.state === 'running' || r.state === 'stopping') && !this.children.has(id) && !(r.pid && alive(r.pid))) {
      this.settle(scope, id, { code: null, signal: null, seen: false });
      return readRecord(dir);
    }
    return r;
  }

  list(scope: ControlScope): ControlRunView[] {
    let ids: string[] = [];
    try { ids = fs.readdirSync(runsDir(scope)).filter((n) => RUN_ID.test(n)); } catch { ids = []; }
    const recs = ids.map((id) => this.read(scope, id)).filter((r): r is ControlRunRecord => Boolean(r));
    recs.sort((a, b) => b.started_at.localeCompare(a.started_at));
    return recs.slice(0, 20).map((r) => this.view(scope, r));
  }

  /** The act's end, read from its stdout: the record settled once (its state from act's own outcome). */
  private settle(scope: ControlScope, id: string, exit: NonNullable<ControlRunRecord['exit']>, error?: string): void {
    const dir = runDirOf(scope, id);
    const r = readRecord(dir);
    if (!r || (r.state !== 'running' && r.state !== 'stopping')) return;
    const act = readActEnd(dir);
    r.exit = exit; r.act = act; r.ended_at = now(); r.pid = null;
    if (act) {
      r.state = act.exit_code === 0 ? 'succeeded' : act.exit_code === 3 ? 'stopped' : act.exit_code === 2 ? 'refused' : 'failed';
      r.why = act.why;
    } else {
      r.state = 'interrupted';
      r.why = error ?? (exit.seen
        ? `timmy act ended (${exit.signal ? `signal ${exit.signal}` : `exit ${exit.code}`}) without printing its end, so how the run ended is not known: Recover settles what it left`
        : 'timmy act is gone and printed no end (the companion that started it was not there to see it end): Recover settles what it left');
    }
    writeRecord(dir, r);
    if (r.state !== 'interrupted') this.seal(scope, dir, r);
  }

  /** The project's receipt for the run, sealed once (appendReceipt, the project's own store). */
  private seal(scope: ControlScope, dir: string, r: ControlRunRecord): void {
    if (r.receipt) return;
    const result = readAgentResult(dir, r);
    const changes = result?.files;
    const files = changes ? [
      ...changes.added.map((f) => ({ path: f.path, ...(f.sha256 ? { sha256: f.sha256 } : {}), created: true, bytes: f.size })),
      ...changes.changed.map((f) => ({ path: f.path, ...(f.sha256 ? { sha256: f.sha256 } : {}), ...(f.previous_sha256 ? { previous_sha256: f.previous_sha256 } : {}), bytes: f.size })),
    ] : [];
    const status = r.state === 'succeeded' ? 'ok' as const : r.state === 'stopped' ? 'cancelled' as const : 'failed' as const;
    try {
      const rc = appendReceipt('runs', {
        kind: 'control-run', subject: `${r.title} run ${r.id}: ${r.task.slice(0, 80)}`, policy: 'human-gated', status,
        project: r.project.name, project_id: r.project.id,
        ...(r.act?.operation ? { operation_id: r.act.operation } : {}),
        ...(result ? { job: { id: result.job, kind: 'agent', label: `${r.harness} ${result.run}`, state: result.outcome ?? r.state, exit_code: result.exit_code ?? null } } : {}),
        ...(files.length ? { files } : {}),
        control_run: {
          run: r.id, harness: r.harness, model: r.model, endpoint: 'local', principal: r.principal, state: r.state,
          act: r.act ? { operation: r.act.operation, outcome: r.act.outcome, exit_code: r.act.exit_code } : null,
          agent: result ? { run: result.run, outcome: result.outcome ?? null, receipt: result.receipt ?? null, deleted: changes?.deleted.length ?? 0 } : null,
          plan_sha256: r.approved.plan_sha256, task_sha256: r.task_sha256, ...(r.stop ? { stopped_by: r.stop.by } : {}),
        },
      }, scope.project.root);
      r.receipt = rc.hash.slice(7, 15);
      writeRecord(dir, r);
    } catch (e) {
      r.why = `${r.why ?? ''} (its receipt could not be sealed in ${r.project.name}: ${msg(e)})`.trim();
      writeRecord(dir, r);
    }
  }

  // ── what the page reads ───────────────────────────────────────────────────────────────────────────────────────────────

  view(scope: ControlScope, r: ControlRunRecord): ControlRunView {
    const dir = runDirOf(scope, r.id);
    const scrub = (s: string): string => scrubHomes(s.split(dir).join(`<run ${r.id}>`).split(path.resolve(scope.project.root)).join(scope.project.name), scope.env as NodeJS.ProcessEnv);
    const live = r.state === 'running' || r.state === 'stopping';
    const result = live ? null : readAgentResult(dir, r);
    const finalMessage = result?.final_message ? readText(path.join(dir, 'work', result.final_message.file), 4000) : null;
    return {
      id: r.id, harness: r.harness, title: r.title, model: r.model, where: r.where, charge: r.charge, wall_time: r.wall_time, task: r.task,
      project: r.project, state: r.state, live, started_at: r.started_at, ...(r.ended_at ? { ended_at: r.ended_at } : {}),
      operation: r.act?.operation ?? runningOperation(dir), job: result?.job ?? null, agent_run: result?.run ?? r.act?.runs.find((x) => x.kind === 'agent')?.id ?? null,
      ...(r.stop ? { stop: r.stop } : {}), ...(r.why ? { why: scrub(r.why) } : {}),
      ...(r.act ? { act: { outcome: r.act.outcome, exit_code: r.act.exit_code, receipts: r.act.receipts } } : {}),
      ...(r.exit ? { exit: r.exit } : {}),
      receipt: r.receipt ?? null,
      approved: r.approved,
      workspace: r.workspace,
      log: tailOf(path.join(dir, 'act.err'), TAIL_MAX).map(scrub),
      ...(result ? {
        result: {
          outcome: result.outcome ?? null, why: result.why ? scrub(result.why) : null, agent_receipt: result.receipt ?? null,
          final_message: finalMessage ? scrub(finalMessage) : null,
          files: result.files ? { added: result.files.added.map((f) => f.path), changed: result.files.changed.map((f) => f.path), deleted: result.files.deleted.map((f) => f.path) } : null,
        },
      } : {}),
    };
  }

  /** Each file the run changed, as a diff against the project (git diff --no-index); a run still running has none yet. */
  diff(scope: ControlScope, id: string): { ok: true; files: Array<{ path: string; kind: 'added' | 'changed' | 'deleted'; diff: string | null; why?: string }>; more: number } | Refusal {
    const dir = this.own(scope, id);
    if (!dir) return { ok: false, status: 404, refused: 'unknown', error: 'No such run in this project.' };
    const r = this.read(scope, id)!;
    if (r.state === 'running' || r.state === 'stopping') return { ok: false, status: 409, refused: 'busy', error: 'The run has not ended: its changes are read when it ends.' };
    const result = readAgentResult(dir, r);
    if (!result?.files) return { ok: true, files: [], more: 0 };
    const all = [
      ...result.files.added.map((f) => ({ path: f.path, kind: 'added' as const })),
      ...result.files.changed.map((f) => ({ path: f.path, kind: 'changed' as const })),
      ...result.files.deleted.map((f) => ({ path: f.path, kind: 'deleted' as const })),
    ];
    const root = path.resolve(scope.project.root);
    const work = path.join(dir, 'work');
    const files = all.slice(0, DIFF_FILES_MAX).map((f) => {
      const rel = f.path;
      if (rel.split(/[\\/]/).includes('..') || path.isAbsolute(rel)) return { ...f, diff: null, why: 'its path leaves the project' };
      const a = f.kind === 'added' ? '/dev/null' : path.join(root, rel);
      const b = f.kind === 'deleted' ? '/dev/null' : path.join(work, rel);
      const g = spawnSync('git', ['diff', '--no-index', '--no-color', '--no-ext-diff', '--', a, b], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 15_000 });
      if (g.error) return { ...f, diff: null, why: `git could not run here (${msg(g.error)}), so no diff is shown` };
      let text = String(g.stdout ?? '');
      text = text.split(work).join('run').split(root).join(scope.project.name);
      if (text.length > DIFF_BYTES_MAX) text = `${text.slice(0, DIFF_BYTES_MAX)}\n… (cut at ${DIFF_BYTES_MAX} bytes)`;
      return { ...f, diff: scrubHomes(text, scope.env as NodeJS.ProcessEnv) || null, ...(text ? {} : { why: 'git found no difference in its bytes' }) };
    });
    return { ok: true, files, more: Math.max(0, all.length - DIFF_FILES_MAX) };
  }

  /** The act processes this companion started, stopped with it (each through act's own stop). */
  async stopAll(waitMs = 20_000): Promise<void> {
    const live = [...this.children.values()].filter((c) => c.exitCode === null && c.signalCode === null);
    await Promise.all(live.map((c) => new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, waitMs);
      c.once('exit', () => { clearTimeout(timer); resolve(); });
      try { c.kill('SIGTERM'); } catch { clearTimeout(timer); resolve(); }
    })));
  }
}

export interface ControlRunView {
  id: string; harness: ControlHarness; title: string; model: string; where: string; charge: string; wall_time: string; task: string;
  project: { id: string; name: string };
  state: ControlState; live: boolean; started_at: string; ended_at?: string;
  operation: string | null; job: string | null; agent_run: string | null;
  stop?: { asked_at: string; by: string }; why?: string;
  act?: { outcome: string; exit_code: number; receipts: Array<{ id: string; kind: string; status?: string }> };
  exit?: { code: number | null; signal: string | null; seen: boolean };
  receipt: string | null;
  approved: { proposal: string; plan_sha256: string; at: string };
  workspace: { files: number; bytes: number; skipped: string[] };
  log: string[];
  result?: { outcome: string | null; why: string | null; agent_receipt: string | null; final_message: string | null; files: { added: string[]; changed: string[]; deleted: string[] } | null };
}

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

async function defaultOpenHandsPreflight(o: { env: Env; bin: string; model: string; root: string }): Promise<{ ok: true; version: string } | { ok: false; error: string }> {
  const [{ OpenHandsRuns }, { glyphSet }] = await Promise.all([import('../repl/openhands.js'), import('../term/glyphs.js')]);
  const planned = planAgent('openhands', 'preflight', { env: o.env, paid: false, run: 'a00000000', bin: o.bin, local: true, root: o.root });
  if (!planned.ok) return { ok: false, error: planned.error };
  const runs = new OpenHandsRuns({ glyphs: glyphSet(true), notify: () => undefined } as never);
  const pre = await runs.preflight(planned.plan, o.env, o.bin);
  return pre.ok ? { ok: true, version: pre.version } : { ok: false, error: pre.error };
}

/** Whether a process with this pid is there (signal 0). */
export function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** A copy of the project for one run: every file but .git, .timmy and node_modules (links as links), within the limits. */
export function copyProject(root: string, to: string): { files: number; bytes: number; skipped: string[] } {
  let files = 0; let bytes = 0;
  const skipped = new Set<string>();
  const walk = (from: string, dest: string, rel: string): void => {
    fs.mkdirSync(dest, { recursive: true });
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
      if (!rel && COPY_SKIP.has(e.name)) { skipped.add(e.name); continue; }
      if (e.name === 'node_modules') { skipped.add(`${rel ? `${rel}/` : ''}node_modules`); continue; }
      const src = path.join(from, e.name); const dst = path.join(dest, e.name);
      if (e.isSymbolicLink()) { fs.symlinkSync(fs.readlinkSync(src), dst); files += 1; continue; }
      if (e.isDirectory()) { walk(src, dst, rel ? `${rel}/${e.name}` : e.name); continue; }
      if (!e.isFile()) { skipped.add(`${rel ? `${rel}/` : ''}${e.name} (not a regular file)`); continue; }
      const st = fs.statSync(src);
      files += 1; bytes += st.size;
      if (files > COPY_MAX_FILES || bytes > COPY_MAX_BYTES) throw new Error(`the project is larger than a run's copy takes (${COPY_MAX_FILES} files, ${Math.round(COPY_MAX_BYTES / 1048576)} MB)`);
      fs.copyFileSync(src, dst);
      fs.chmodSync(dst, st.mode & 0o777);
    }
  };
  walk(path.resolve(root), to, '');
  return { files, bytes, skipped: [...skipped].sort() };
}

function readActEnd(dir: string): ControlRunRecord['act'] {
  try {
    const lines = fs.readFileSync(path.join(dir, 'act.out'), 'utf8').trim().split('\n').filter(Boolean);
    const j = JSON.parse(lines[lines.length - 1] ?? '') as { schema?: string; operation?: string | null; outcome?: string; exit_code?: number; why?: string; runs?: Array<{ kind: string; id: string }>; receipts?: Array<{ id: string; kind: string; status?: string }> | null };
    if (j.schema !== 'timmy.act/1' || typeof j.exit_code !== 'number') return null;
    return { operation: j.operation ?? null, outcome: String(j.outcome ?? ''), exit_code: j.exit_code, why: String(j.why ?? ''), runs: Array.isArray(j.runs) ? j.runs : [], receipts: Array.isArray(j.receipts) ? j.receipts : [] };
  } catch { return null; }
}

/** The operation the act holds while it runs: the one record in its workspace's operations folder. */
function runningOperation(dir: string): string | null {
  try { const n = fs.readdirSync(path.join(dir, 'work', '.timmy', 'operations')).filter((f) => f.endsWith('.json')).sort(); return n.length ? n[n.length - 1].replace(/\.json$/, '') : null; } catch { return null; }
}

/** The agent's result.json in the run's workspace (the run named by act's end, else the only one there). */
function readAgentResult(dir: string, r: ControlRunRecord): AgentRunRecord | null {
  const base = path.join(dir, 'work', AGENTS_DIR);
  let run = r.act?.runs.find((x) => x.kind === 'agent')?.id;
  if (!run) { try { const n = fs.readdirSync(base); if (n.length === 1) run = n[0]; } catch { /* none */ } }
  if (!run || !/^[A-Za-z0-9_-]{1,40}$/.test(run)) return null;
  try { return JSON.parse(fs.readFileSync(path.join(base, run, 'result.json'), 'utf8')) as AgentRunRecord; } catch { return null; }
}

function readText(file: string, max: number): string | null {
  try { const t = fs.readFileSync(file, 'utf8'); return t.length > max ? `${t.slice(0, max)}…` : t; } catch { return null; }
}

function tailOf(file: string, n: number): string[] {
  try {
    const st = fs.statSync(file);
    const fd = fs.openSync(file, 'r');
    const len = Math.min(st.size, 64 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    // eslint-disable-next-line no-control-regex
    return buf.toString('utf8').replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').split('\n').filter((l) => l.trim()).slice(-n);
  } catch { return []; }
}

// ── the routes ──────────────────────────────────────────────────────────────────────────────────────────────────────────
//
//   GET  /api/control/harnesses        the two harnesses (found here or what they need), this machine's local models
//   POST /api/control/propose          { harness, task, model, limit }: the plan, checked, nothing started (a proposal id)
//   POST /api/control/runs             { proposal }: Approve and start (the proposal used once)
//   GET  /api/control/runs             the project's runs, newest first
//   GET  /api/control/runs/:id         one run (its log's last lines while it runs; its end, result and receipt after)
//   POST /api/control/runs/:id/stop    Stop (act's own stop path)
//   POST /api/control/runs/:id/recover Recover an interrupted run (timmy act /recover in its workspace)
//   GET  /api/control/runs/:id/diff    each changed file's diff against the project
//
// Every route: the companion's token, then the principal (a signed-in user's verified session, or this computer's operator
// when no identity provider is configured), then that principal's project; a run of another principal or project is 404.


export const CONTROL_ROUTES = { harnesses: '/api/control/harnesses', propose: '/api/control/propose', runs: '/api/control/runs' } as const;

export interface ControlRoutesContext {
  withToken: express.RequestHandler;
  withUser: express.RequestHandler;
  json: express.RequestHandler;
  /** the request's principal and project, with that principal's environment; null when it has no project here */
  scopeOf: (req: express.Request) => ControlScope | null;
  runs: ControlRuns;
  fetch?: typeof fetch;
}

const NO_PROJECT = 'No project is open for this page, so no run can be shown or started.';

export function mountControlRuns(app: express.Express, ctx: ControlRoutesContext): void {
  const scoped = (h: (req: express.Request, res: express.Response, scope: ControlScope) => void | Promise<void>, body = false): express.RequestHandler[] => [ctx.withToken, ctx.withUser, ...(body ? [ctx.json] : []), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const scope = ctx.scopeOf(req);
    if (!scope) { res.status(404).json({ ok: false, error: NO_PROJECT }); return; }
    try { await h(req, res, scope); } catch (e) { res.status(500).json({ ok: false, error: `The Control Room could not answer: ${scrubHomes(msg(e), scope.env as NodeJS.ProcessEnv)}` }); }
  }];
  const answer = (res: express.Response, r: { ok: true } | Refusal, body: Record<string, unknown> = {}): void => {
    if (r.ok) res.json({ ...r, ...body }); else res.status(r.status).json({ ok: false, refused: r.refused, error: r.error });
  };
  app.get(CONTROL_ROUTES.harnesses, ...scoped(async (_req, res, scope) => {
    const models = await localModels(scope.env, ctx.fetch ?? fetch);
    res.json({ ok: true, harnesses: harnessStates(scope.env), models: models.ok ? models.models : [], ...(models.ok ? {} : { modelsError: models.error }), limit: { default: LIMIT_DEFAULT_MIN, max: LIMIT_MAX_MIN }, project: { name: scope.project.name } });
  }));
  app.post(CONTROL_ROUTES.propose, ...scoped(async (req, res, scope) => { answer(res, await ctx.runs.propose(scope, (req.body ?? {}) as Record<string, unknown>)); }, true));
  app.post(CONTROL_ROUTES.runs, ...scoped((req, res, scope) => { answer(res, ctx.runs.start(scope, (req.body ?? {}) as Record<string, unknown>)); }, true));
  app.get(CONTROL_ROUTES.runs, ...scoped((_req, res, scope) => { res.json({ ok: true, runs: ctx.runs.list(scope), project: { name: scope.project.name } }); }));
  app.get(`${CONTROL_ROUTES.runs}/:id`, ...scoped((req, res, scope) => {
    const r = ctx.runs.read(scope, String(req.params.id));
    if (!r) { res.status(404).json({ ok: false, error: 'No such run in this project.' }); return; }
    res.json({ ok: true, run: ctx.runs.view(scope, r) });
  }));
  app.post(`${CONTROL_ROUTES.runs}/:id/stop`, ...scoped((req, res, scope) => { answer(res, ctx.runs.stop(scope, String(req.params.id))); }));
  app.post(`${CONTROL_ROUTES.runs}/:id/recover`, ...scoped((req, res, scope) => { answer(res, ctx.runs.recover(scope, String(req.params.id))); }));
  app.get(`${CONTROL_ROUTES.runs}/:id/diff`, ...scoped((req, res, scope) => { answer(res, ctx.runs.diff(scope, String(req.params.id))); }));
}
