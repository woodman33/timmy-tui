// TIMMY Command Post v0.1 — typed dispatch contract + controller.
// Equip riders; don't ride: this PREPARES, ARMS and LAUNCHES work into
// existing harness lanes (LANE_RUNNERS + tmux vocabulary). It is not a second
// scheduler; the later tldraw Mission Map compiles into these same calls.
import { accessSync, constants, existsSync, lstatSync, readFileSync, realpathSync, writeFileSync, mkdirSync, mkdtempSync, readdirSync, rmdirSync, rmSync, statSync } from 'fs';
import { basename, delimiter, isAbsolute, join, dirname, relative, resolve, sep } from 'path';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { planHashOf, consumeApproval } from './approvals.js';
import { appendReceipt } from './receipts.js';
import { captureEnvLock, type EnvLock } from './envlock.js';
import { harnessFields } from '../harness/policy.js';
import { publish as appendEvent } from '../bus/index.js';
import { LANE_RUNNERS } from '../agent/lanes.js';

// R4 lead (2026-10-12): shellWord lives in its own module (src/agent/lanes.ts uses it too); still exported from here.
import { shellWord } from './shell-word.js';
export { shellWord };

/**
 * R4 lead (2026-10-12; found by H115 reading the Pi lane): a lane's one-shot command with its task in it, as the pane's shell
 * gets it. Before, only " was escaped in the objective, so $(...), `...`, $VAR and \ in it (a dropped file's name, a page's
 * request, a phrase) ran as shell code in the lane's pane. Where the template quotes its task ("{task}": a prompt), the task is
 * one shell word holding the objective exactly; where it takes the task as words (paths and flags: `hyperframes render
 * {task}`), each word is quoted so: words, never shell code.
 */
export function laneCommand(template: string, objective: string): string {
  if (template.includes('"{task}"')) return template.replace('"{task}"', () => shellWord(objective));
  const words = objective.trim().split(/\s+/).filter(Boolean).map(shellWord).join(' ');
  return template.replace('{task}', () => words);
}
import { mcporterLaneServer, mcporterServerConfigured } from '../connectors/mcp-configured.js'; // R4 (H107; r25 D13)
import { keySet } from './keys.js';
import { selectFromCone, type ContextCone, type ConeSelection } from './context-cone.js';
import { openHandsPreflight, runOpenHandsTask } from './openhands-adapter.js';
import { dockerReady } from './doctor.js';

export type Lifecycle =
  | 'draft' | 'ready' | 'armed' | 'running' | 'needs_approval'
  | 'judging' | 'passed' | 'failed' | 'promoted' | 'archived';

export interface DispatchPlan {
  schema_version: 'dispatch/0.1';
  objective: string;
  deliverables: string[];
  acceptance_tests: string[];
  harnesses: string[];
  model_policy: { requested: string; allow_paid: boolean; max_spend_usd: number };
  copies: number;
  cadence: { mode: 'parallel' | 'sequential'; depends_on: string[] };
  context_manifest: { path: string; sha256: string }[];
  /** V-01 rung 2: provenance of a cone-derived manifest; isolation seeds only these paths */
  context_cone?: {
    budget_tokens: number;
    selected_tokens: number;
    entries: { id: string; tier: 'L0' | 'L1' | 'L2'; tokens: number; path?: string }[];
  };
  repo_ref: string;
  workspace: { kind: 'docker' | 'host-ephemeral'; image?: string; path?: string };
  permissions: { filesystem: 'ro' | 'rw-ephemeral'; network: boolean; tools: string[]; secrets: string[] };
  limits: { tokens?: number; cost_usd: number; steps?: number; wall_ms: number };
  retry_limit: number;
  approval: { required: boolean; mode: 'manual' | 'delegated-envelope' };
  expected_artifacts: string[];
  telemetry: { redact: boolean; events: boolean };
}

/** R9 (H161; R8's open item K): one of the plan's required outputs (`expected_artifacts`), as its copy was released. */
export interface DispatchOutput {
  /** as the plan names it, relative to the copy */
  path: string;
  /** kept: copied into the dispatch record with its sha256; missing: the copy had no such file; not_kept: there, and not taken */
  state: 'kept' | 'missing' | 'not_kept';
  sha256?: string;
  bytes?: number;
  why?: string;
}

/**
 * R9 (H161; R8's open item K): the temporary copy a dispatch made (establishIsolation), as its record keeps it. `path` is the
 * folder mkdtemp made in `root` (the temporary folder then), with the marker file COPY_MARKER written in it at once, holding the
 * plan's id and `marker`; only a folder with all of these is ever removed. in_use: made and not released; removed: Timmy removed
 * it (after its session ended and its outputs were kept, or at once when no session started); kept: left, `why` says why;
 * gone: not there when its session ended (something else removed it).
 */
export interface DispatchCopy {
  path: string;
  root: string;
  marker: string;
  made_at: string;
  state: 'in_use' | 'removed' | 'kept' | 'gone';
  why?: string;
  removed_at?: string;
  /** where its outputs were kept, relative to the project: .timmy/dispatch/<id>/outputs */
  outputs_at?: string;
  outputs?: DispatchOutput[];
}

export interface StoredPlan {
  id: string;
  plan: DispatchPlan;
  plan_hash: string;
  lifecycle: Lifecycle;
  approved_hash?: string;
  session?: string;
  dispatched_at?: string;
  blocked?: { state: 'not_configured' | 'blocked'; note: string };
  /** R9 (H161): the temporary copy this dispatch made, and what became of it */
  copy?: DispatchCopy;
}

const sha = (p: string): string => crypto.createHash('sha256').update(readFileSync(p)).digest('hex');
const storeDir = (dir?: string) => join(dir ?? process.cwd(), '.timmy', 'dispatch');
const planPath = (id: string, dir?: string) => join(storeDir(dir), `${id}.json`);
const readStored = (id: string, dir?: string): StoredPlan | null => {
  try { return JSON.parse(readFileSync(planPath(id, dir), 'utf8')) as StoredPlan; } catch { return null; }
};
const writeStored = (s: StoredPlan, dir?: string) => {
  mkdirSync(storeDir(dir), { recursive: true });
  writeFileSync(planPath(s.id, dir), JSON.stringify(s, null, 2));
};
const ev = (kind: string, s: StoredPlan, extra: Record<string, unknown> = {}, dir?: string) =>
  appendEvent(kind, { plan_id: s.id, plan_hash: s.plan_hash, harness: s.plan.harnesses.join(','), status: s.lifecycle, ...extra }, dir);

// CUE validates structure (owner amendment: CUE only at v0.1, no Nickel).
export function validatePlanCue(plan: unknown, dir?: string): { ok: boolean; note?: string; error_class?: string } {
  const cueBin = spawnSync('cue', ['version'], { encoding: 'utf8' });
  if (cueBin.status !== 0) return { ok: false, error_class: 'not_configured', note: 'cue binary missing (brew install cue)' };
  // schema lives in the repo, independent of the data dir
  const schema = fileURLToPath(new URL('../../schemas/dispatch.cue', import.meta.url));
  const folder = mkdtempSync(join(tmpdir(), 'timmy-cue-'));
  // Round R4 (H29): the folder is removed whatever the check finds (thousands had piled up in the temp folder).
  try {
    const tmp = join(folder, 'plan.json');
    writeFileSync(tmp, JSON.stringify(plan));
    const r = spawnSync('cue', ['vet', '-d', '#Plan', schema, tmp], { encoding: 'utf8' });
    if (r.status !== 0) return { ok: false, error_class: 'schema', note: (r.stderr || r.stdout || 'cue vet failed').slice(0, 400) };
    return { ok: true };
  } finally {
    try { rmSync(folder, { recursive: true, force: true }); } catch { /* left behind: the check's outcome stands */ }
  }
}

/** Whether `cmd` is an executable on PATH. No shell: Node 24 warns (DEP0190) on a shell with arguments. */
function onPath(cmd: string): boolean {
  return (process.env.PATH ?? '').split(delimiter).filter(Boolean).some((dir) => {
    try { accessSync(join(dir, cmd), constants.X_OK); return statSync(join(dir, cmd)).isFile(); } catch { return false; }
  });
}

// R1 lanes honesty: a lane is ready only when everything it runs on is here. An API lane runs on
// curl AND its key (a placeholder counts as missing; the key's name is returned, never its value),
// and hyperframes runs through npx, which alone only means the package could be fetched.
const LANE_COMMAND: Record<string, string> = { hyperframes: 'hyperframes' };
const LANE_INSTALL: Record<string, string> = { hyperframes: 'npm install -g hyperframes' };

/** R4 (H107; r25 D13): an MCP-backed lane's server: whether its program is on PATH and its server configured for Timmy. */
export interface LaneMcp { server: string; program: string; found: boolean; configured: boolean; where?: string; checked: string[]; unreadable?: string[] }

export function listLanes(env: NodeJS.ProcessEnv = process.env, o: { cwd?: string } = {}): { id: string; label: string; available: boolean; install?: string; model?: string; key?: string; mcp?: LaneMcp }[] {
  return Object.entries(LANE_RUNNERS).map(([id, r]) => {
    const found = onPath(LANE_COMMAND[id] ?? r.cmd);
    // R4 (H107; r25 D13): a lane that runs `mcporter call <server>.…` is ready only when that server is configured for Timmy
    // (MCPorter's config files, read; nothing is run or contacted): mcporter on PATH alone said "found" on the Mac
    const server = mcporterLaneServer(r);
    const mcp: LaneMcp | undefined = server ? { server, program: r.cmd, found, ...mcporterServerConfigured(server, { env, ...(o.cwd ? { cwd: o.cwd } : {}) }) } : undefined;
    return {
      id, label: r.label,
      available: found && (!r.key || keySet(env[r.key])) && (!mcp || mcp.configured),
      install: LANE_INSTALL[id] ?? r.install, model: r.model,
      ...(r.key ? { key: r.key } : {}),
      ...(mcp ? { mcp } : {}),
    };
  });
}

// V-01 rung 2 (v0.7.6): the cone selects token-budgeted L0/L1/L2 slices; this
// turns the selection into the sha-pinned context_manifest a capsule seeds.
// Fails closed on budget_exceeded, path escapes, and missing entries.
export function coneToContextManifest(cone: ContextCone, opts?: { budgetOverride?: number; repoRoot?: string }): { ok: boolean; manifest?: { path: string; sha256: string }[]; selection?: ConeSelection; error_class?: string; note?: string } {
  const root = resolve(opts?.repoRoot ?? process.cwd());
  const sel = selectFromCone(cone, opts?.budgetOverride);
  if (!sel.ok) return { ok: false, selection: sel, error_class: sel.error_class, note: sel.note };
  const manifest: { path: string; sha256: string }[] = [];
  for (const e of sel.entries) {
    if (!e.path) continue;
    const src = resolve(root, e.path);
    if (!src.startsWith(root + '/')) return { ok: false, selection: sel, error_class: 'blocked', note: `cone path escapes repo: ${e.path}` };
    if (!existsSync(src)) return { ok: false, selection: sel, error_class: 'missing_source', note: `cone entry missing: ${e.path}` };
    manifest.push({ path: e.path, sha256: sha(src) });
  }
  return { ok: true, manifest, selection: sel };
}

export function createPlan(plan: DispatchPlan, dir?: string, cone?: ContextCone): { ok: boolean; id?: string; plan_hash?: string; validation?: unknown; note?: string } {
  if (cone) {
    const cm = coneToContextManifest(cone);
    if (!cm.ok) return { ok: false, validation: { error_class: cm.error_class, note: cm.note }, note: cm.note ?? cm.error_class };
    plan = {
      ...plan,
      context_manifest: cm.manifest!,
      context_cone: {
        budget_tokens: cone.budget_tokens,
        selected_tokens: cm.selection!.tokens,
        entries: cm.selection!.entries.map(e => ({ id: e.id, tier: e.tier, tokens: e.tokens, ...(e.path ? { path: e.path } : {}) }))
      }
    };
  }
  const validation = validatePlanCue(plan, dir);
  if (!validation.ok) return { ok: false, validation, note: validation.note };
  if (!plan.harnesses || plan.harnesses.length < 1) return { ok: false, note: 'no harnesses' };
  for (const h of plan.harnesses) {
    if (!LANE_RUNNERS[h]) return { ok: false, note: `unknown harness '${h}'`, validation: { available: Object.keys(LANE_RUNNERS) } };
  }
  const id = `dp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const stored: StoredPlan = { id, plan, plan_hash: planHashOf(plan), lifecycle: plan.approval.required ? 'needs_approval' : 'ready' };
  writeStored(stored, dir);
  ev('dispatch.created', stored, {}, dir);
  return { ok: true, id, plan_hash: stored.plan_hash, validation };
}

// Approval binds the COMPLETE immutable plan hash; any mutation invalidates.
export function armPlan(id: string, approval: string, dir?: string): { ok: boolean; note?: string; plan_hash?: string } {
  const s = readStored(id, dir);
  if (!s) return { ok: false, note: 'unknown plan' };
  // preflight (friction log #2): containerized plans cannot arm while the
  // docker daemon is down — checked BEFORE consuming the one-shot token so a
  // bad environment never burns operator authority. DRYRUN bypasses (the
  // mechanical path is explicitly not the real sandbox).
  if (s.plan.workspace.kind === 'docker' && process.env.TIMMY_DISPATCH_DRYRUN !== '1' && !dockerReady()) {
    ev('dispatch.arm_denied', s, { note: 'docker not_configured' }, dir);
    appendReceipt('runs', { kind: 'run', subject: `dispatch ${id} arm BLOCKED (preflight)`, policy: 'human-gated', status: 'failed', error_class: 'not_configured', plan_hash: s.plan_hash, discrepancies: ['docker daemon down — timmy doctor preflight'], spans: [], artifacts: [] }, dir);
    return { ok: false, note: 'docker daemon not_configured — containerized plans cannot arm (timmy doctor preflight)', plan_hash: s.plan_hash };
  }
  const gate = consumeApproval(approval, s.plan_hash);
  if (!gate.ok) {
    s.lifecycle = 'needs_approval';
    writeStored(s, dir);
    ev('dispatch.arm_denied', s, { note: gate.note }, dir);
    appendReceipt('runs', { kind: 'run', subject: `dispatch ${id} arm DENIED`, policy: 'human-gated', status: 'denied', error_class: 'approval', plan_hash: s.plan_hash, spans: [], artifacts: [] }, dir);
    return { ok: false, note: gate.note, plan_hash: s.plan_hash };
  }
  s.approved_hash = s.plan_hash;
  s.lifecycle = 'armed';
  writeStored(s, dir);
  ev('dispatch.armed', s, {}, dir);
  return { ok: true, plan_hash: s.plan_hash };
}

// bounded: a saturated tmux server must stall a dispatch, not hang it.
// R8 (H156; R7's open item H): TIMMY_TMUX_SOCKET=<label> runs every tmux call of a dispatch (start, read, hold, cancel) on the
// server of that label (`tmux -L <label>`); unset or blank, the default server, as before. The tests that dispatch set it
// (tests/helpers/dispatch-tmux.ts): a dry run's pane keeps its shell open after its `sleep 30`, and on the default server
// those sessions stayed after every full suite.
const tmux = (args: string[]) => {
  const label = process.env.TIMMY_TMUX_SOCKET?.trim();
  return spawnSync('tmux', label ? ['-L', label, ...args] : args, { encoding: 'utf8', timeout: 5000 });
};

// ── R9 (H161; R8's open item K): the dispatch's temporary copy ─────────────────────────────────────────────────────────
//
// Up to R8 a dispatch's copy (`timmy-dp-<id>-…` in the temporary folder; one for a docker workspace too) was never removed: 9
// more after each run of the dispatch tests, and one per real dispatch. A copy is now made with a marker file of its own and
// recorded in the dispatch record (StoredPlan.copy), and it is removed only when both hold: its session has ended (tmux
// has-session false on the server TIMMY_TMUX_SOCKET names) and the plan's required outputs (`expected_artifacts`) are kept in
// the project's dispatch record (.timmy/dispatch/<id>/outputs), each with its sha256, or recorded as missing. A copy with an
// output that could not be kept is left, and its record says so and why. Only the recorded folder is removed: an absolute path
// directly in the temporary folder it was made in, named timmy-dp-<id>-<6 characters>, a folder (not a link), holding this
// dispatch's marker. Nothing else is ever removed. A copy whose isolation failed, or whose session tmux did not start, is
// removed at once by the same check: nothing ran in it, and it has no outputs.
//
// Where a dispatch's session is seen to end, today: tailLane (capture-pane fails: "session gone"), collectRun (reads the pane,
// never ends it), pauseOrCancelLane (hold suspends the pane with C-z; cancel ends it, kill-session), the fleet (runFleetMission
// leaves its lanes running and never ends one) and the MCP, companion (/mission) and DispatchRail callers (each passes through
// to one of these). A dispatch's pane keeps its shell after the lane's command, so a session does not end by itself. The one
// place the copy is released is pauseOrCancelLane's cancel (releaseCopy, after its kill-session): the only point where Timmy
// itself ends the session, so has-session is asked right after the end it caused; a cancel of a session that had already ended
// (killed elsewhere) releases its copy the same way. collectRun and the others only say what the copy's state is.

const COPY_MARKER = '.timmy-dispatch-copy';
const nowIso = (): string => new Date().toISOString();
const errWords = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').slice(0, 200);
/** The project's dispatch record of a dispatch's kept outputs: .timmy/dispatch/<id>/outputs, relative to the project. */
const outputsRel = (id: string): string => `.timmy/dispatch/${id}/outputs`;

/** The copy's folder made (mkdtemp in the temporary folder), with its marker file written in it at once. */
function makeCopy(s: StoredPlan): { ok: true; copy: DispatchCopy } | { ok: false; note: string } {
  const root = tmpdir();
  const path = mkdtempSync(join(root, `timmy-dp-${s.id}-`));
  const copy: DispatchCopy = { path, root, marker: crypto.randomBytes(12).toString('hex'), made_at: nowIso(), state: 'in_use' };
  try {
    writeFileSync(join(path, COPY_MARKER), `${JSON.stringify({ plan_id: s.id, marker: copy.marker, made_at: copy.made_at, note: 'made by Timmy\'s dispatch: this folder is removed once its session has ended and its outputs are kept' })}\n`, { flag: 'wx', mode: 0o600 });
  } catch (e) {
    // the folder is empty (only just made): rmdir removes an empty folder and nothing else
    try { rmdirSync(path); } catch { /* left: its record has no copy, so nothing names it */ }
    return { ok: false, note: `the temporary copy's marker could not be written: ${errWords(e)}` };
  }
  return { ok: true, copy };
}

/** Whether the folder the record names is the copy this dispatch made (every check of the header above), or why not. */
function ownCopy(id: string, copy: DispatchCopy): { ok: true } | { ok: false; gone?: boolean; why: string } {
  const prefix = `timmy-dp-${id}-`;
  const name = basename(copy.path ?? '');
  if (typeof copy.path !== 'string' || !isAbsolute(copy.path) || dirname(copy.path) !== copy.root || !name.startsWith(prefix) || !/^[A-Za-z0-9]{6}$/.test(name.slice(prefix.length))) {
    return { ok: false, why: `not removed: the folder its record names is not a ${prefix}… folder in the temporary folder it was made in (it removes only a folder it made)` };
  }
  let st;
  try { st = lstatSync(copy.path); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ok: false, gone: true, why: 'it was not there when its session ended (something else removed it), so its outputs could not be kept' };
    return { ok: false, why: `not removed: it could not be read (${errWords(e)})` };
  }
  if (st.isSymbolicLink() || !st.isDirectory()) return { ok: false, why: 'not removed: what its record names is not a folder (a link or a file): it removes only a folder it made' };
  try {
    const m = join(copy.path, COPY_MARKER);
    const ms = lstatSync(m);
    const mark = ms.isFile() ? JSON.parse(readFileSync(m, 'utf8')) as { plan_id?: unknown; marker?: unknown } : null;
    if (mark && mark.plan_id === id && mark.marker === copy.marker) return { ok: true };
  } catch { /* no marker, or not one of this dispatch's */ }
  return { ok: false, why: 'not removed: the folder its record names has no marker of this dispatch (it removes only a folder it made)' };
}

/** Each of the plan's required outputs copied from the copy into the dispatch record with its sha256, or why it was not. */
function keepOutputs(s: StoredPlan, copy: DispatchCopy, dir?: string): DispatchOutput[] {
  const base = resolve(copy.path);
  let real = base;
  try { real = realpathSync(base); } catch { /* as made */ }
  const at = resolve(dir ?? process.cwd(), outputsRel(s.id));
  return (s.plan.expected_artifacts ?? []).map((p): DispatchOutput => {
    const src = resolve(base, p);
    if (!src.startsWith(base + sep)) return { path: p, state: 'not_kept', why: 'outside the copy' };
    let st;
    try { st = lstatSync(src); } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'ENOENT' || (e as NodeJS.ErrnoException).code === 'ENOTDIR' ? { path: p, state: 'missing' } : { path: p, state: 'not_kept', why: `it could not be read (${errWords(e)})` };
    }
    if (st.isSymbolicLink()) return { path: p, state: 'not_kept', why: 'a symbolic link: not followed' };
    if (st.isDirectory()) return { path: p, state: 'not_kept', why: 'a folder: only files are kept' };
    if (!st.isFile()) return { path: p, state: 'not_kept', why: 'not a regular file' };
    try {
      // a folder on its way that is a link (out -> elsewhere, then out/file) is not followed either
      if (realpathSync(dirname(src)) !== join(real, relative(base, dirname(src)))) return { path: p, state: 'not_kept', why: 'reached through a symbolic link: not followed' };
      const bytes = readFileSync(src);
      const digest = crypto.createHash('sha256').update(bytes).digest('hex');
      const dst = resolve(at, relative(base, src));
      if (!dst.startsWith(at + sep)) return { path: p, state: 'not_kept', why: 'outside the dispatch record' };
      mkdirSync(dirname(dst), { recursive: true });
      writeFileSync(dst, bytes);
      if (sha(dst) !== digest) return { path: p, state: 'not_kept', why: 'its kept copy did not read back the same bytes' };
      return { path: p, state: 'kept', sha256: digest, bytes: bytes.length };
    } catch (e) {
      return { path: p, state: 'not_kept', why: `it could not be kept (${errWords(e)})` };
    }
  });
}

/** Removes the copy this dispatch made, after ownCopy: why not, or null once it is gone. */
function removeCopy(id: string, copy: DispatchCopy): string | null {
  const own = ownCopy(id, copy);
  if (!own.ok) return own.why;
  try { rmSync(copy.path, { recursive: true }); } catch (e) { return `not removed: ${errWords(e)}`; }
  return existsSync(copy.path) ? 'not removed: the folder was still there after its removal' : null;
}

/** A copy no session ever ran in (its isolation failed, or tmux started no session): removed at once, through ownCopy. */
function removeAtOnce(id: string, copy: DispatchCopy, because: string): DispatchCopy {
  const why = removeCopy(id, copy);
  return why ? { ...copy, state: 'kept', why } : { ...copy, state: 'removed', removed_at: nowIso(), why: `removed at once: ${because}, so nothing ran in it` };
}

/** What the copy's state is, in words (the record, its events, collect's and cancel's answers and the cancel's receipt). */
export function copyWords(s: Pick<StoredPlan, 'id' | 'copy' | 'session'>, o: { sessionRuns?: boolean | null; why?: string } = {}): string {
  const c = s.copy;
  if (!c) return 'no temporary copy is recorded for this dispatch (none was made, or it was dispatched before Timmy recorded them)';
  const where = basename(c.path ?? '');
  if (c.state === 'removed') {
    if (c.why) return `temporary copy ${c.why}`;
    return `temporary copy removed after the session ended; outputs kept at ${c.outputs_at ?? outputsRel(s.id)}${c.outputs?.length ? '' : ' (the plan names none)'}`;
  }
  if (c.state === 'kept') return `temporary copy kept in the temporary folder (${where}): ${c.why ?? 'why is not recorded'}`;
  if (c.state === 'gone') return `temporary copy ${c.why ?? 'gone'}`;
  if (o.sessionRuns === false) return `temporary copy in use (${where}): the session has ended; a cancel keeps its outputs and removes the copy`;
  if (o.sessionRuns === null) return `temporary copy in use (${where}): whether the session still runs is not known (${o.why ?? 'tmux gave no answer'}); a cancel ends it, then keeps its outputs and removes the copy`;
  return `temporary copy in use (${where}): ${c.why ?? 'the session still runs'}; once a cancel has ended it, its outputs are kept and the copy is removed`;
}

/** Whether the dispatch's session is there now (tmux has-session, exact name, on TIMMY_TMUX_SOCKET's server); null: not known. */
function sessionRuns(session: string | undefined): { runs: boolean | null; why?: string } {
  if (!session) return { runs: false };
  const h = tmux(['has-session', '-t', `=${session}`]);
  if (h.error) return { runs: null, why: `tmux could not be asked (${errWords(h.error)})` };
  if (h.status === 0) return { runs: true };
  if (h.status === 1) return { runs: false };
  return { runs: null, why: `tmux answered ${h.status}: ${errWords(h.stderr || h.stdout || '')}` };
}

/**
 * R9 (H161): the one place a dispatch's copy is released (see the header above; called by pauseOrCancelLane's cancel). It
 * changes the record's copy in place; the caller writes the record, its events and its receipt.
 */
function releaseCopy(s: StoredPlan, dir?: string): DispatchCopy | undefined {
  const c = s.copy;
  if (!c || c.state !== 'in_use') return c;
  const ended = sessionRuns(s.session);
  if (ended.runs !== false) {
    c.why = ended.runs ? 'not removed yet: the session still runs' : `not removed yet: whether the session ended is not known: ${ended.why}`;
    return c;
  }
  const own = ownCopy(s.id, c);
  if (!own.ok) {
    if (own.gone) { c.state = 'gone'; c.why = own.why; c.outputs = (s.plan.expected_artifacts ?? []).map((p) => ({ path: p, state: 'missing' as const, why: 'the copy was gone' })); return c; }
    c.state = 'kept';
    c.why = own.why;
    return c;
  }
  c.outputs = keepOutputs(s, c, dir);
  c.outputs_at = outputsRel(s.id);
  const notKept = c.outputs.filter((o) => o.state === 'not_kept');
  if (notKept.length) {
    c.state = 'kept';
    c.why = `outputs that could not be kept: ${notKept.map((o) => `${o.path} (${o.why})`).join('; ')}`;
    return c;
  }
  const why = removeCopy(s.id, c);
  if (why) { c.state = 'kept'; c.why = why; return c; }
  c.state = 'removed';
  c.removed_at = nowIso();
  delete c.why;
  return c;
}

/** The receipt's account of the copy: the outputs kept (path in the project, sha256, bytes) and what was not, in words. */
function copyReceiptFields(s: StoredPlan): { outputs?: Array<{ path: string; sha256?: string; bytes: number }>; discrepancies?: string[] } {
  const c = s.copy;
  if (!c) return {};
  const kept = (c.outputs ?? []).filter((o) => o.state === 'kept').map((o) => ({ path: `${c.outputs_at ?? outputsRel(s.id)}/${o.path.split(sep).join('/')}`, sha256: o.sha256, bytes: o.bytes ?? 0 }));
  const lines = (c.outputs ?? []).filter((o) => o.state !== 'kept').map((o) => (o.state === 'missing' ? `${o.path}: missing (${o.why ?? 'the copy had no such file when its session ended'})` : `${o.path}: ${o.why}`));
  if (!lines.length && c.why && c.state !== 'removed') lines.push(c.why);
  return { ...(kept.length ? { outputs: kept } : {}), ...(lines.length ? { discrepancies: lines } : {}) };
}

// Real sandbox or nothing: docker disposable, or host-ephemeral temp copy.
// Never the live checkout; never a changed directory as a claimed jail.
function establishIsolation(s: StoredPlan): { ok: boolean; workdir?: string; copy?: DispatchCopy; note?: string; state?: 'not_configured' | 'blocked' } {
  const repoRoot = process.cwd();
  if (s.plan.workspace.kind === 'docker') {
    const info = spawnSync('docker', ['info'], { encoding: 'utf8', timeout: 15000 });
    if (info.status !== 0) return { ok: false, state: 'not_configured', note: 'docker daemon unavailable — fail closed' };
    const made = makeCopy(s);
    if (!made.ok) return { ok: false, state: 'blocked', note: made.note };
    return { ok: true, workdir: made.copy.path, copy: made.copy };
  }
  const hinted = s.plan.workspace.path;
  if (hinted && (hinted === repoRoot || hinted.startsWith(repoRoot + '/'))) {
    return { ok: false, state: 'blocked', note: 'workspace inside live checkout — refused (isolation law)' };
  }
  const made = makeCopy(s);
  if (!made.ok) return { ok: false, state: 'blocked', note: made.note };
  const workdir = made.copy.path;
  // R9 (H161): a refusal after the copy was made removes it at once (no session started; nothing ran in it)
  const refuse = (note: string) => ({ ok: false, state: 'blocked' as const, note, copy: removeAtOnce(s.id, made.copy, 'isolation failed before any session started') });
  // cone law (v0.7.6): a cone-derived capsule seeds ONLY the budgeted
  // selection — unconstrained blobs riding the manifest are refused
  const allowed = s.plan.context_cone
    ? new Set(s.plan.context_cone.entries.map(e => e.path).filter((p): p is string => Boolean(p)))
    : null;
  // seed the temp copy: hash-verified manifest files read from the governing
  // repo; the pane only ever sees the ephemeral copy (isolation law)
  for (const m of s.plan.context_manifest ?? []) {
    if (allowed && !allowed.has(m.path)) return refuse(`context outside cone selection: ${m.path}`);
    const src = resolve(repoRoot, m.path);
    if (!src.startsWith(resolve(repoRoot) + '/')) return refuse(`context path escapes repo: ${m.path}`);
    if (!existsSync(src)) return refuse(`context missing: ${m.path}`);
    const got = sha(src);
    if (got !== m.sha256) return refuse(`context hash mismatch: ${m.path} (want ${m.sha256.slice(0, 12)}… got ${got.slice(0, 12)}…)`);
    const dst = resolve(workdir, m.path);
    if (!dst.startsWith(resolve(workdir) + '/')) return refuse(`context path escapes workspace: ${m.path}`);
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(dst, readFileSync(src));
  }
  return { ok: true, workdir, copy: made.copy };
}

export function dispatchPlan(id: string, dir?: string): { ok: boolean; note?: string; session?: string; blocked?: { state: string; note: string } } {
  const s = readStored(id, dir);
  if (!s) return { ok: false, note: 'unknown plan' };
  if (s.lifecycle !== 'armed') return { ok: false, note: `plan not armed (lifecycle ${s.lifecycle}) — chat prepares, authority launches` };
  const currentHash = planHashOf(s.plan);
  if (s.approved_hash !== currentHash || currentHash !== s.plan_hash) {
    s.plan_hash = currentHash;
    s.lifecycle = 'needs_approval';
    writeStored(s, dir);
    ev('dispatch.mutation_denied', s, {}, dir);
    appendReceipt('runs', { kind: 'run', subject: `dispatch ${id} DENIED (plan mutated post-approval)`, policy: 'human-gated', status: 'denied', error_class: 'approval', plan_hash: s.plan_hash, spans: [], artifacts: [] }, dir);
    return { ok: false, note: 'plan mutated after approval — approval invalidated' };
  }
  const iso = establishIsolation(s);
  if (!iso.ok) {
    s.blocked = { state: iso.state!, note: iso.note! };
    s.lifecycle = 'failed';
    // R9 (H161): a copy made before the refusal was removed at once (establishIsolation); the record says so
    if (iso.copy) s.copy = iso.copy;
    writeStored(s, dir);
    ev('dispatch.isolation_failed', s, { note: iso.note, ...(iso.copy ? { copy: copyWords(s) } : {}) }, dir);
    appendReceipt('runs', { kind: 'run', subject: `dispatch ${id} isolation FAILED${iso.copy ? ` · ${copyWords(s)}` : ''}`, policy: 'human-gated', status: 'failed', error_class: iso.state === 'not_configured' ? 'not_configured' : 'env', plan_hash: s.plan_hash, discrepancies: [iso.note!], spans: [], artifacts: [] }, dir);
    return { ok: false, note: iso.note, blocked: s.blocked };
  }
  // R9 (H161): the record names the copy from now on, before any session can run in it
  s.copy = iso.copy;
  writeStored(s, dir);
  const runner = LANE_RUNNERS[s.plan.harnesses[0]];
  const session = `timmy-dp-${s.id}`;
  // R4 lead (H115's finding): the objective reaches the shell as text, never as shell code (laneCommand)
  const cmd = laneCommand(runner.task ?? `${runner.cmd} "{task}"`, s.plan.objective);
  tmux(['kill-session', '-t', `=${session}`]);
  const ns = tmux(['new-session', '-d', '-s', session, '-c', iso.workdir!]);
  if (ns.status !== 0) {
    s.lifecycle = 'failed';
    // R9 (H161): tmux started no session in the copy, so it is removed at once; unless tmux did not answer in time, when
    // whether a session started is not known, and the copy is left for a cancel to release
    if (s.copy) {
      const timedOut = (ns.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
      s.copy = timedOut ? { ...s.copy, why: 'not removed yet: tmux did not answer in 5 s, so whether a session started is not known' } : removeAtOnce(s.id, s.copy, 'tmux started no session');
      if (timedOut) s.session = session;
    }
    writeStored(s, dir);
    if (s.copy) ev('dispatch.spawn_failed', s, { copy: copyWords(s) }, dir);
    return { ok: false, note: 'tmux spawn failed' };
  }
  // TIMMY_DISPATCH_DRYRUN=1: exercise session mechanics without launching a
  // real harness (tests, demos). Isolation + approval gates still apply.
  const launchCmd = process.env.TIMMY_DISPATCH_DRYRUN === '1'
    ? `echo TIMMY_DISPATCH_DRYRUN ${s.id}; sleep 30`
    : `cd ${shellWord(iso.workdir!)} && ${cmd}`;
  tmux(['send-keys', '-t', session, launchCmd, 'Enter']);
  s.session = session;
  s.lifecycle = 'running';
  s.dispatched_at = new Date().toISOString();
  writeStored(s, dir);
  ev('dispatch.launched', s, { session, workdir: iso.workdir }, dir);
  appendReceipt('runs', {
    kind: 'run', subject: `dispatch ${id} · ${s.plan.harnesses[0]} · ${s.plan.copies}x`,
    policy: s.plan.approval.mode === 'delegated-envelope' ? 'human-gated' : 'human-gated',
    status: 'ok', plan_hash: s.plan_hash, max_spend: s.plan.limits.cost_usd,
    ...harnessFields(s.plan.harnesses[0], dir),
    env_lock: captureEnvLock(['ffmpeg', 'ffprobe', s.plan.harnesses[0]], dir),
    spans: [{ name: `dispatch ${s.plan.harnesses[0]}`, kind: 'invoke_agent' }], artifacts: []
  }, dir);
  return { ok: true, session };
}

export function getPlan(id: string, dir?: string): StoredPlan | null {
  return readStored(id, dir);
}

export function listPlans(dir?: string): StoredPlan[] {
  const d = join(dir ?? process.cwd(), '.timmy', 'dispatch');
  try {
    return readdirSync(d)
      .filter(f => f.endsWith('.json'))
      .map(f => readStored(f.replace(/\.json$/, ''), dir))
      .filter((s): s is StoredPlan => Boolean(s))
      .sort((a, b) => String(b.dispatched_at ?? '').localeCompare(String(a.dispatched_at ?? '')));
  } catch { return []; }
}

// Live containerized lane (v0.7.6): an armed openhands+docker plan runs
// through the OpenHands docker engine with telemetry on the event bus (SSE
// to the Mission Studio). Authority was consumed at arm time against THIS
// plan hash; the adapter records that hash (preApproved) instead of re-
// minting — unidirectional authority, no second token.
export async function dispatchContainerized(id: string, dir?: string): Promise<{ ok: boolean; note?: string; container?: boolean; blocked?: { state: string; note: string } }> {
  const s = readStored(id, dir);
  if (!s) return { ok: false, note: 'unknown plan' };
  if (s.lifecycle !== 'armed') return { ok: false, note: `plan not armed (lifecycle ${s.lifecycle}) — chat prepares, authority launches` };
  const currentHash = planHashOf(s.plan);
  if (s.approved_hash !== currentHash || currentHash !== s.plan_hash) {
    s.plan_hash = currentHash;
    s.lifecycle = 'needs_approval';
    writeStored(s, dir);
    ev('dispatch.mutation_denied', s, {}, dir);
    appendReceipt('runs', { kind: 'run', subject: `dispatch ${id} DENIED (plan mutated post-approval)`, policy: 'human-gated', status: 'denied', error_class: 'approval', plan_hash: s.plan_hash, spans: [], artifacts: [] }, dir);
    return { ok: false, note: 'plan mutated after approval — approval invalidated' };
  }
  if (process.env.TIMMY_DISPATCH_DRYRUN === '1') {
    s.session = `container-dryrun-${s.id}`;
    s.lifecycle = 'running';
    s.dispatched_at = new Date().toISOString();
    writeStored(s, dir);
    ev('dispatch.container_started', s, { dryrun: true }, dir);
    s.lifecycle = 'judging';
    writeStored(s, dir);
    ev('dispatch.container_done', s, { dryrun: true, ok: true }, dir);
    return { ok: true, container: true };
  }
  const pre = openHandsPreflight();
  if (!pre.ok) {
    s.blocked = { state: 'not_configured', note: pre.note! };
    s.lifecycle = 'failed';
    writeStored(s, dir);
    ev('dispatch.container_failed', s, { note: pre.note }, dir);
    appendReceipt('runs', { kind: 'run', subject: `dispatch ${id} container not_configured`, policy: 'human-gated', status: 'failed', error_class: 'not_configured', plan_hash: s.plan_hash, discrepancies: [pre.note!], spans: [], artifacts: [] }, dir);
    return { ok: false, note: pre.note, blocked: s.blocked };
  }
  s.session = `container-${s.id}`;
  s.lifecycle = 'running';
  s.dispatched_at = new Date().toISOString();
  writeStored(s, dir);
  ev('dispatch.container_started', s, { engine: 'docker' }, dir);
  let lastLog = 0;
  void runOpenHandsTask({
    task: s.plan.objective,
    acceptance: s.plan.acceptance_tests,
    engine: 'docker',
    wall_ms: s.plan.limits.wall_ms,
    max_spend: s.plan.limits.cost_usd,
    llm: s.plan.model_policy.allow_paid ? 'auto' : 'local',
    preApproved: { plan_hash: s.plan_hash },
    onLine: chunk => {
      const now = Date.now();
      if (now - lastLog < 1500) return;
      lastLog = now;
      ev('dispatch.container_log', s, { line: chunk.replace(/\s+/g, ' ').slice(0, 240) }, dir);
    },
    dir,
  }).then(r => {
    const s2 = readStored(id, dir);
    if (!s2) return;
    s2.lifecycle = r.ok ? 'judging' : 'failed';
    if (!r.ok) s2.blocked = { state: r.state ?? 'blocked', note: r.note ?? 'container run failed' };
    writeStored(s2, dir);
    ev(r.ok ? 'dispatch.container_done' : 'dispatch.container_failed', s2, { ok: r.ok, receipt: r.receipt ?? null, note: r.note ?? null }, dir);
  });
  return { ok: true, container: true };
}

export function tailLane(id: string, dir?: string): { ok: boolean; lines?: string[]; note?: string; lifecycle?: Lifecycle; copy?: CopyAnswer } {
  const s = readStored(id, dir);
  if (!s?.session) return { ok: false, note: 'no session for plan' };
  const cap = tmux(['capture-pane', '-p', '-t', s.session]);
  if (cap.status !== 0) {
    s.lifecycle = s.lifecycle === 'running' ? 'failed' : s.lifecycle;
    writeStored(s, dir);
    // R9 (H161): the end is seen here, and the copy is not released here (a cancel releases it): its words say so
    const now = s.copy?.state === 'in_use' ? sessionRuns(s.session) : null;
    return { ok: false, note: 'session gone', lifecycle: s.lifecycle, ...(s.copy ? { copy: copyAnswer(s, now ? { sessionRuns: now.runs, ...(now.why ? { why: now.why } : {}) } : {}) } : {}) };
  }
  return { ok: true, lines: (cap.stdout ?? '').split('\n').slice(-40), lifecycle: s.lifecycle };
}

/** R9 (H161): what a dispatch's answer says of its copy: its state and its words (copyWords). */
export interface CopyAnswer { state: DispatchCopy['state'] | 'none'; words: string }
const copyAnswer = (s: StoredPlan, o: { sessionRuns?: boolean | null; why?: string } = {}): CopyAnswer => ({ state: s.copy?.state ?? 'none', words: copyWords(s, o) });

export function pauseOrCancelLane(id: string, action: 'hold' | 'cancel', dir?: string): { ok: boolean; note?: string; copy?: CopyAnswer } {
  const s = readStored(id, dir);
  if (!s) return { ok: false, note: 'unknown plan' };
  if (action === 'hold') {
    // (exact: `=<name>:` is that session's own pane, never another session whose name begins with it)
    if (s.session) tmux(['send-keys', '-t', `=${s.session}:`, 'C-z']);
    s.lifecycle = 'archived';
    writeStored(s, dir);
    ev('dispatch.held', s, {}, dir);
    // a held session has not ended: its copy stays in use
    return { ok: true, ...(s.copy ? { copy: copyAnswer(s) } : {}) };
  }
  if (s.session) tmux(['kill-session', '-t', `=${s.session}`]);
  s.lifecycle = 'archived';
  // R9 (H161; R8's open item K): the one place a dispatch's copy is released (see the copy's header above): the session ended
  // here, its outputs kept in the dispatch record, then the copy removed; or left, with why
  releaseCopy(s, dir);
  writeStored(s, dir);
  ev('dispatch.cancelled', s, {}, dir);
  if (s.copy) {
    const kind = s.copy.state === 'removed' ? 'dispatch.copy_removed' : s.copy.state === 'kept' ? 'dispatch.copy_kept' : s.copy.state === 'gone' ? 'dispatch.copy_gone' : 'dispatch.copy_in_use';
    ev(kind, s, { words: copyWords(s), copy: basename(s.copy.path ?? ''), ...(s.copy.outputs_at ? { outputs_at: s.copy.outputs_at } : {}), ...(s.copy.outputs ? { outputs: s.copy.outputs } : {}) }, dir);
  }
  appendReceipt('runs', { kind: 'run', subject: `dispatch ${id} cancelled${s.copy ? ` · ${copyWords(s)}` : ''}`, policy: 'human-gated', status: 'failed', error_class: 'cancelled', plan_hash: s.plan_hash, ...copyReceiptFields(s), spans: [], artifacts: [] }, dir);
  return { ok: true, ...(s.copy ? { copy: copyAnswer(s) } : {}) };
}

export function collectRun(id: string, dir?: string): { ok: boolean; lines?: string[]; over_wall?: boolean; elapsed_ms?: number; receipt?: string; lifecycle?: Lifecycle; copy?: CopyAnswer } {
  const s = readStored(id, dir);
  if (!s) return { ok: false } as any;
  const tail = s.session ? tmux(['capture-pane', '-p', '-t', s.session]) : null;
  const lines = tail?.status === 0 ? (tail.stdout ?? '').split('\n').slice(-60) : [];
  const elapsed_ms = s.dispatched_at ? Date.now() - new Date(s.dispatched_at).getTime() : 0;
  const over_wall = elapsed_ms > s.plan.limits.wall_ms;
  s.lifecycle = over_wall ? 'failed' : 'judging';
  writeStored(s, dir);
  const rec = appendReceipt('runs', {
    kind: 'run', subject: `dispatch ${id} collect · ${over_wall ? 'WALL EXCEEDED' : 'awaiting judge'}`,
    policy: 'human-gated', status: over_wall ? 'failed' : 'ok',
    ...(over_wall ? { error_class: 'wall_time' as const } : {}),
    plan_hash: s.plan_hash, ms: elapsed_ms,
    ...harnessFields(s.plan.harnesses[0], dir),
    env_lock: captureEnvLock(['ffmpeg', 'ffprobe', s.plan.harnesses[0]], dir),
    spans: [{ name: `collect ${s.plan.harnesses[0]}`, kind: 'execute_tool' }],
    artifacts: []
  }, dir);
  ev('dispatch.collected', s, { over_wall, elapsed_ms }, dir);
  // R9 (H161): collecting never ends the session nor removes the copy (a cancel does); it says what the copy's state is
  const now = s.copy?.state === 'in_use' ? sessionRuns(s.session) : null;
  const copy = s.copy ? copyAnswer(s, now ? { sessionRuns: now.runs, ...(now.why ? { why: now.why } : {}) } : {}) : undefined;
  return { ok: true, lines, over_wall, elapsed_ms, receipt: rec.hash, lifecycle: s.lifecycle, ...(copy ? { copy } : {}) };
}

export const dispatchHashOf = planHashOf;
export { sha as dispatchSha };
