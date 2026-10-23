// Command Post v0.1 — first harness slide: OpenHands, REAL SANDBOX OR NOTHING.
// Every run: disposable workspace (ephemeral repo copy), pinned ref, scoped
// limits, deterministic acceptance tests. OpenHands' own runtime is
// docker-backed; we additionally verify the daemon up front and fail closed.
// PTY/tmux is watch/attach/recovery only — structured spawn here.
import { existsSync, mkdirSync, writeFileSync, readFileSync, mkdtempSync, readdirSync, rmSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import { spawnSync, spawn } from 'child_process';
import crypto from 'crypto';
import { appendReceipt } from './receipts.js';
import { publish as appendEvent } from '../bus/index.js';
import { planHashOf, consumeApproval } from './approvals.js';
// R11 (H169, Phase 0 item 3): the run's model call goes through the route policy like every other (free-only, local-only)
import { checkRoute, routePolicyNow, type RoutePolicy } from '../agent/route-policy.js';
import type { PolicyRoute, RouteCheck } from '../agent/route-check.js';

const sha = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');

export interface OpenHandsOpts {
  task: string;
  acceptance: string[];          // shell commands run in the workspace; all must exit 0
  fixture_repo?: string;         // git url/dir to clone (pinned ref) — else scaffold
  ref?: string;
  wall_ms?: number;
  no_activity_ms?: number;       // A2 fail-fast: no tool/file activity within N → kill
  max_iterations?: number;
  max_spend?: number;            // A3: required >0 when llm==='auto'
  llm?: 'local' | 'auto';        // default local (ollama), $0-first
  local_model?: string;          // default ollama/qwen3.8:27b-mlx (capable local)
  engine?: 'sdk' | 'cli' | 'docker'; // C: docker = ephemeral runner container (default)
  approval?: string;             // operator token bound to this task's plan hash
  onLine?: (chunk: string) => void; // live telemetry tap (caller throttles)
  /** authority consumed upstream (dispatch arm bound to this hash) — skips the internal token gate and records the chain */
  preApproved?: { plan_hash: string };
  dir?: string;
}

export interface OpenHandsResult {
  ok: boolean;
  state?: 'not_configured' | 'blocked';
  note?: string;
  plan_hash?: string;
  workdir?: string;
  patch?: string;
  patch_sha256?: string;
  acceptance?: { cmd: string; code: number }[];
  /** Patch applied to a pristine clone inside the sandbox; must be green too. */
  pristine_acceptance?: { cmd: string; code: number }[];
  host_canary?: boolean;
  duration_ms?: number;
  receipt?: string;
}

export const openHandsPlanHash = (o: OpenHandsOpts): string =>
  planHashOf({ tool: 'timmy_openhands_run', task: o.task, acceptance: o.acceptance, ref: o.ref ?? null, wall_ms: o.wall_ms ?? 300000, max_iterations: o.max_iterations ?? 4, llm: o.llm ?? 'local', local_model: o.local_model ?? DEFAULT_LOCAL_MODEL, no_activity_ms: o.no_activity_ms ?? 90000, max_spend: o.max_spend ?? 0, engine: o.engine ?? 'docker' });

/** The local model a run asks unless one is named (OpenHands' `ollama/<name>` form). */
export const DEFAULT_LOCAL_MODEL = 'ollama/qwen3.8:27b-mlx';
/** llm 'auto': OpenRouter's router picks a model per request (openrouter/auto): a paid cloud route whose price is not known before the run. */
export const OPENROUTER_AUTO = 'openrouter/auto';

/**
 * R11 (H169, Phase 0 item 3): the model call a run makes, as the route policy reads it (src/agent/route-check.ts). llm 'local'
 * (the default): the named local model on this computer's Ollama (the runner reaches it at host.docker.internal, the host's
 * own 127.0.0.1:11434). llm 'auto': openrouter/auto, a cloud route (local-only refuses it) that OpenRouter routes to a model
 * of its own choosing, so no price is known before the run (free-only refuses it: unknown is never free).
 */
export function openHandsRoute(o: Pick<OpenHandsOpts, 'llm' | 'local_model'>): PolicyRoute {
  if ((o.llm ?? 'local') === 'local') {
    return { source: 'ollama-local', model: (o.local_model ?? DEFAULT_LOCAL_MODEL).replace(/^ollama\//, ''), host: '127.0.0.1:11434', role: 'tool', tool: 'timmy_openhands_run' };
  }
  return { source: 'openrouter', model: OPENROUTER_AUTO, role: 'tool', tool: 'timmy_openhands_run' };
}
/** The policy's answer for a run's route (the price of openrouter/auto is never known before the run). */
export function checkOpenHandsRoute(o: Pick<OpenHandsOpts, 'llm' | 'local_model'>, policy: RoutePolicy = routePolicyNow()): RouteCheck {
  const route = openHandsRoute(o);
  return checkRoute(route, policy, route.source === 'openrouter'
    ? { price: () => ({ id: OPENROUTER_AUTO, free: null, tools: null, from: 'none', catalogAt: null, words: 'OpenRouter routes each request to a model of its own choosing, so no price is known before the run' }) }
    : {});
}

// Pinned runner image (scripts/oh-runner.Dockerfile); versions mirror the host
// uv tool environment so local and containerized runs are comparable.
export const OH_RUNNER_IMAGE = 'timmy-oh-runner:1.21.0';
/** R11 (H170; Phase 0 item 4): the build is the operator's, run once in the repository root; Timmy never builds or pulls it. */
export const OH_RUNNER_BUILD = `docker build -f scripts/oh-runner.Dockerfile -t ${OH_RUNNER_IMAGE} .`;
export const OH_RUNNER_NOT_BUILT = `the image ${OH_RUNNER_IMAGE} is not built; build it yourself, in the repository root: ${OH_RUNNER_BUILD} (Timmy never builds or pulls it by itself; nothing was started)`;

const HOST_PATH_RE = /\/Users\/|\/home\/|C:\\/;

export function openHandsPreflight(): { ok: boolean; state?: 'not_configured'; note?: string } {
  const d = spawnSync('docker', ['info'], { encoding: 'utf8', timeout: 15000 });
  if (d.status !== 0) return { ok: false, state: 'not_configured', note: 'docker daemon unavailable — OpenHands isolation fails closed' };
  const o = spawnSync('openhands', ['--version'], { encoding: 'utf8', timeout: 15000 });
  if (o.status !== 0) return { ok: false, state: 'not_configured', note: 'openhands binary missing (uv tool install openhands --python 3.12)' };
  return { ok: true };
}

const scaffoldFixture = (work: string) => {
  writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'timmy-oh-fixture', version: '0.0.1', scripts: { test: 'node test.js' } }, null, 2));
  writeFileSync(join(work, 'add.js'), 'module.exports = { add: (a, b) => a - b }; // deliberate red\n');
  writeFileSync(join(work, 'test.js'), `const { add } = require('./add.js');\nif (add(1, 2) !== 3) { console.error('RED: add(1,2) !== 3'); process.exit(1); }\nconsole.log('GREEN');\n`);
};

export async function runOpenHandsTask(o: OpenHandsOpts): Promise<OpenHandsResult> {
  const dir = o.dir ?? process.cwd();
  const planHash = openHandsPlanHash(o);
  // paid/remote work default-deny: operator token bound to the complete task
  // hash. preApproved = the dispatch controller already consumed a token bound
  // to the dispatch plan hash at arm time (unidirectional authority).
  const gate = o.preApproved ? { ok: true as const } : consumeApproval(o.approval ?? '', planHash);
  if (!gate.ok) {
    const rec = appendReceipt('runs', { kind: 'run', subject: 'openhands run DENIED (approval)', policy: 'human-gated', status: 'denied', error_class: 'approval', plan_hash: planHash, spans: [], artifacts: [] }, dir);
    appendEvent('openhands.denied', { plan_hash: planHash, note: gate.note }, dir);
    return { ok: false, state: 'blocked', note: `${gate.note} — mint: timmy approve ${planHash}`, plan_hash: planHash, receipt: rec.hash };
  }
  // A3 spend guard: frontier models only under a hard max_spend bound
  if ((o.llm ?? 'local') === 'auto' && !(Number(o.max_spend) > 0)) {
    const rec = appendReceipt('runs', { kind: 'run', subject: 'openhands run DENIED (spend policy)', policy: 'human-gated', status: 'denied', error_class: 'spend_policy', plan_hash: planHash, discrepancies: ['llm=auto requires max_spend > 0 in the approved plan'], spans: [], artifacts: [] }, dir);
    return { ok: false, state: 'blocked', note: 'llm=auto requires max_spend > 0', plan_hash: planHash, receipt: rec.hash };
  }
  // R11 (H169, Phase 0 item 3): the route policy, read now: llm 'auto' is openrouter/auto, a cloud route of unknown price, so
  // local-only and free-only each refuse it in their own words; a local model is checked too (a cloud-named one is refused
  // under local-only). Refused before docker is asked and before any workspace is made: nothing is started
  const routeCheck = checkOpenHandsRoute(o);
  if (!routeCheck.ok) {
    const rec = appendReceipt('runs', { kind: 'run', subject: 'openhands run DENIED (route policy)', policy: 'human-gated', status: 'denied', error_class: 'route_policy', plan_hash: planHash, discrepancies: [routeCheck.words], spans: [], artifacts: [] }, dir);
    appendEvent('openhands.denied', { plan_hash: planHash, note: routeCheck.words, reason: routeCheck.reason }, dir);
    return { ok: false, state: 'blocked', note: routeCheck.words, plan_hash: planHash, receipt: rec.hash };
  }
  // R11 (H169, Phase 0 item 3): llm 'auto' needs the OpenRouter key this process holds (LLM_API_KEY or OPENROUTER_API_KEY in
  // its environment); none set, nothing is started (the key never goes into a command line: see the engines below)
  const llmLocal = (o.llm ?? 'local') === 'local';
  const apiKey = llmLocal ? 'ollama' : (process.env.LLM_API_KEY?.trim() || process.env.OPENROUTER_API_KEY?.trim() || '');
  if (!llmLocal && !apiKey) {
    const words = 'llm=auto asks OpenRouter, and no key is set (OPENROUTER_API_KEY or LLM_API_KEY in this process\'s environment), so nothing was started';
    const rec = appendReceipt('runs', { kind: 'run', subject: 'openhands run not_configured', policy: 'human-gated', status: 'failed', error_class: 'not_configured', plan_hash: planHash, discrepancies: [words], spans: [], artifacts: [] }, dir);
    appendEvent('openhands.not_configured', { plan_hash: planHash }, dir);
    return { ok: false, state: 'not_configured', note: words, plan_hash: planHash, receipt: rec.hash };
  }
  const engine = o.engine ?? 'docker';
  if (engine === 'docker') {
    // REAL SANDBOX OR NOTHING: no daemon → fail closed, never fall back to host
    const d = spawnSync('docker', ['info'], { encoding: 'utf8', timeout: 15000 });
    if (d.status !== 0) {
      const rec = appendReceipt('runs', { kind: 'run', subject: 'openhands run not_configured', policy: 'human-gated', status: 'failed', error_class: 'not_configured', plan_hash: planHash, discrepancies: ['docker daemon unavailable — container isolation fails closed'], spans: [], artifacts: [] }, dir);
      appendEvent('openhands.not_configured', { plan_hash: planHash }, dir);
      return { ok: false, state: 'not_configured', note: 'docker daemon unavailable — isolation fails closed', plan_hash: planHash, receipt: rec.hash };
    }
    // R11 (H170; Phase 0 item 4): inventory before install. The runner image is looked for and never built here (the auto-build
    // ran a 600 s `docker build` with network when it was missing, against the inventory-before-install rule; the R4 route's
    // --pull never is the model): absent, the run is refused before any workspace is made, with the one command that builds it.
    const img = spawnSync('docker', ['image', 'inspect', OH_RUNNER_IMAGE], { encoding: 'utf8', timeout: 15000 });
    if (img.status !== 0) {
      const rec = appendReceipt('runs', { kind: 'run', subject: 'openhands runner image not built', policy: 'human-gated', status: 'failed', error_class: 'not_configured', plan_hash: planHash, discrepancies: [OH_RUNNER_NOT_BUILT], spans: [], artifacts: [] }, dir);
      appendEvent('openhands.not_configured', { plan_hash: planHash, image: OH_RUNNER_IMAGE }, dir);
      return { ok: false, state: 'not_configured', note: OH_RUNNER_NOT_BUILT, plan_hash: planHash, receipt: rec.hash };
    }
  } else {
    const bin = spawnSync('openhands', ['--version'], { encoding: 'utf8', timeout: 15000 });
    if (bin.status !== 0) {
      const rec = appendReceipt('runs', { kind: 'run', subject: 'openhands run not_configured', policy: 'human-gated', status: 'failed', error_class: 'not_configured', plan_hash: planHash, discrepancies: ['openhands binary missing'], spans: [], artifacts: [] }, dir);
      appendEvent('openhands.not_configured', { plan_hash: planHash }, dir);
      return { ok: false, state: 'not_configured', note: 'openhands binary missing', plan_hash: planHash, receipt: rec.hash };
    }
  }
  const work = mkdtempSync(join(tmpdir(), 'timmy-oh-'));
  if (o.fixture_repo) {
    const cl = spawnSync('git', ['clone', '--depth', '1', ...(o.ref ? ['--branch', o.ref] : []), o.fixture_repo, work], { encoding: 'utf8', timeout: 120000 });
    if (cl.status !== 0) {
      const rec = appendReceipt('runs', { kind: 'run', subject: 'openhands clone failed', policy: 'human-gated', status: 'failed', error_class: 'missing_source', plan_hash: planHash, spans: [], artifacts: [] }, dir);
      return { ok: false, state: 'blocked', note: 'fixture clone failed', plan_hash: planHash, workdir: work, receipt: rec.hash };
    }
  } else {
    scaffoldFixture(work);
    spawnSync('git', ['init', '-q'], { cwd: work });
    spawnSync('git', ['add', '-A'], { cwd: work });
    spawnSync('git', ['-c', 'user.email=timmy@local', '-c', 'user.name=timmy', 'commit', '-q', '-m', 'red fixture'], { cwd: work });
  }
  const t0 = Date.now();
  // A1: seeded disposable workspace — never shared/live. C: the docker engine
  // moves the whole runner (agent loop + tools) into an ephemeral container
  // whose ONLY mount is the workspace; host engines remain explicit opt-in.
  const llmEnv = {
    LLM_MODEL: llmLocal ? (o.local_model ?? DEFAULT_LOCAL_MODEL) : OPENROUTER_AUTO,
    LLM_API_KEY: apiKey,
    LLM_BASE_URL: llmLocal
      ? (engine === 'docker' ? 'http://host.docker.internal:11434' : 'http://localhost:11434')
      : 'https://openrouter.ai/api/v1'
  };
  let child: ReturnType<typeof spawn>;
  let canaryAuthoritative = false;
  // R11 (H169, Phase 0 item 3): the key reaches the runner through docker's --env-file (a file of this process's own, 0600,
  // in a folder of its own outside the workspace, removed when the runner exits), never on the docker command line, where
  // every process list and shell history would show it
  let envFileDir: string | null = null;
  if (engine === 'docker') {
    envFileDir = mkdtempSync(join(tmpdir(), 'timmy-oh-env-'));
    const envFile = join(envFileDir, 'runner.env');
    writeFileSync(envFile, Object.entries(llmEnv).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
    // R11 (H170; Phase 0 item 4): the image was inventoried above; it is never built here (see OH_RUNNER_NOT_BUILT)
    child = spawn('docker', ['run', '--rm', '-i',
      '--cap-drop=ALL', '--security-opt', 'no-new-privileges',
      '--pids-limit', '256', '--memory', '2g', '--cpus', '2',
      '--add-host', 'host.docker.internal:host-gateway',
      '-v', `${work}:/work`,
      '--env-file', envFile,
      OH_RUNNER_IMAGE], { cwd: work, env: { ...process.env, TERM: 'dumb', NO_COLOR: '1', CI: '1' } });
    child.stdin?.write(JSON.stringify({ task: o.task, workspace: '/work', acceptance: o.acceptance, pristine_dir: '/pristine' }));
    child.stdin?.end();
    canaryAuthoritative = true;
  } else {
    const UV_PY = join(homedir(), '.local', 'share', 'uv', 'tools', 'openhands', 'bin', 'python');
    const useSdk = engine === 'sdk' && existsSync(UV_PY);
    child = spawn(useSdk ? UV_PY : 'openhands',
      useSdk ? [join(dir, 'scripts', 'openhands-sdk-bridge.py')] : ['--headless', '-t', o.task, '--always-approve', '--override-with-envs'], {
      cwd: work,
      env: { ...process.env, OPENHANDS_WORK_DIR: work, OPENHANDS_SUPPRESS_BANNER: '1', TERM: 'dumb', NO_COLOR: '1', CI: '1', ...llmEnv }
    });
    if (useSdk) {
      const pristineHost = mkdtempSync(join(tmpdir(), 'timmy-oh-pristine-'));
      child.stdin?.write(JSON.stringify({ task: o.task, workspace: work, acceptance: o.acceptance, pristine_dir: pristineHost }));
      child.stdin?.end();
    }
  }
  let tail = '';
  let fullOut = '';
  let killed: string | null = null;
  const snap = (): string => {
    try { return readdirSync(work).map(f => { try { return String(statSync(join(work, f)).mtimeMs); } catch { return 'x'; } }).join(','); } catch { return ''; }
  };
  const lastMtime = { v: snap() };
  const lastActivity = { v: Date.now() };
  const noAct = o.no_activity_ms ?? 90000;   // A2 fail-fast
  const wall = o.wall_ms ?? 300000;
  child.stderr?.on('data', d => {
    const s = d.toString();
    tail = (tail + s).slice(-2000);
    o.onLine?.(s);
    if (/file_editor|terminal|Execut|edit|read/i.test(s)) lastActivity.v = Date.now();
  });
  child.stdout?.on('data', d => { const s = d.toString(); tail = (tail + s).slice(-2000); fullOut = (fullOut + s).slice(-200000); o.onLine?.(s); lastActivity.v = Date.now(); });
  const watcher = setInterval(() => {
    const m = snap();
    if (m !== lastMtime.v) { lastMtime.v = m; lastActivity.v = Date.now(); }
    const now = Date.now();
    if (now - t0 > wall) { killed = 'wall_time'; child.kill(); }
    else if (now - lastActivity.v > noAct) { killed = 'no_tool_activity'; child.kill(); }
  }, 5000);
  await new Promise<void>(resolve => child.on('exit', () => resolve()));
  clearInterval(watcher);
  if (envFileDir) { try { rmSync(envFileDir, { recursive: true, force: true }); } catch { /* the folder is this process's own, in the OS temp folder */ } }
  const run = { status: killed ? null : (child.exitCode ?? 0), stdout: tail, stderr: tail };
  const duration_ms = Date.now() - t0;
  const acceptance = (o.acceptance ?? []).map(cmd => ({
    cmd,
    code: spawnSync('bash', ['-c', cmd], { cwd: work, encoding: 'utf8', timeout: 60000 }).status ?? 1
  }));
  const patch = spawnSync('git', ['diff', 'HEAD'], { cwd: work, encoding: 'utf8' }).stdout ?? '';
  const allGreen = acceptance.length > 0 && acceptance.every(a => a.code === 0);
  // A4 host-path scan at seal — isolation violations never seal clean
  const hostLeak = HOST_PATH_RE.test(patch);
  // bridge envelope (last JSON line with host_canary): isolation + patch lifecycle
  let envelope: { host_canary?: boolean; patch?: string; pristine_acceptance?: { cmd: string; code: number }[]; patch_applied?: boolean; note?: string } = {};
  for (const line of fullOut.split('\n').reverse()) {
    const t = line.trim();
    if (!t.startsWith('{') || !t.includes('host_canary')) continue;
    try { envelope = JSON.parse(t); break; } catch { continue; }
  }
  const pristine = envelope.pristine_acceptance ?? [];
  const pristineGreen = pristine.length > 0 && pristine.every(a => a.code === 0);
  const canaryTripped = canaryAuthoritative && envelope.host_canary === true;
  // A4: host-path scan at seal — isolation violations never seal clean.
  // C: container runs must also prove the patch ports to a pristine clone.
  const errClass = killed
    ?? (canaryTripped || hostLeak ? 'isolation_violation'
      : (!allGreen ? 'acceptance_red'
        : (engine === 'docker' && !pristineGreen ? 'patch_not_portable' : undefined)));
  const childRec = appendReceipt('runs', {
    kind: 'run', subject: `openhands ${engine} · ${killed ?? (canaryTripped || hostLeak ? 'ISOLATION VIOLATION' : (allGreen ? 'green' : 'red'))}`, policy: 'human-gated',
    status: !errClass ? 'ok' : 'failed',
    ...(errClass ? { error_class: errClass as string } : {}),
    plan_hash: planHash, ms: duration_ms,
    ...(o.preApproved ? { authority: 'dispatch-armed', dispatch_plan_hash: o.preApproved.plan_hash } : {}),
    ...(engine === 'docker' ? { container_image: OH_RUNNER_IMAGE, host_canary: envelope.host_canary ?? null } : {}),
    spans: [{ name: `openhands ${engine} (seeded disposable workspace)`, kind: 'invoke_agent' }],
    artifacts: []
  }, dir);
  // structured events from --json stdout land on the bus (SDK-grade evidence);
  // usage/cost ride up onto the parent receipt (loop runs BEFORE the parent)
  let evCost = 0;
  let evTokens = 0;
  for (const line of (run.stdout ?? '').split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const e = JSON.parse(t);
      if (e && typeof e === 'object') {
        evCost += Number(e.cost ?? e.usage?.cost ?? 0) || 0;
        evTokens += Number(e.usage?.total_tokens ?? e.tokens ?? 0) || 0;
        appendEvent('openhands.event', { plan_hash: planHash, kind: e.kind ?? e.type ?? 'event', ...e }, dir);
      }
    } catch { /* non-event json line */ }
  }
  appendEvent('openhands.completed', { plan_hash: planHash, green: allGreen, duration_ms, killed }, dir);
  const parent = appendReceipt('runs', {
    kind: 'verify', subject: `openhands acceptance · ${acceptance.filter(a => a.code === 0).length}/${acceptance.length} green`,
    policy: 'human-gated', status: !errClass ? 'ok' : 'failed',
    ...(errClass ? { error_class: errClass as string } : {}),
    plan_hash: planHash, output_sha256: sha(patch),
    ...(evCost > 0 ? { cost_usd: evCost } : {}),
    ...(evTokens > 0 ? { tokens: evTokens } : {}),
    ...(engine === 'docker' ? {
      container_image: OH_RUNNER_IMAGE,
      host_canary: envelope.host_canary ?? null,
      patch_applied_to_pristine: envelope.patch_applied ?? false,
      pristine_acceptance: pristine
    } : {}),
    child_receipts: [childRec.hash],
    spans: [{ name: 'acceptance tests', kind: 'execute_tool' }],
    artifacts: []
  }, dir);
  // failure evidence rides on the result (work order: never swallow why)
  const output_tail = !errClass ? undefined : (killed ? `killed: ${killed} · ` : '') + (envelope.note ? `bridge: ${envelope.note} · ` : '') + tail.slice(-600);
  return { ok: !errClass, plan_hash: planHash, workdir: work, patch, patch_sha256: sha(patch), acceptance, pristine_acceptance: pristine, host_canary: envelope.host_canary, duration_ms, receipt: parent.hash, note: output_tail };
}

export { readFileSync as _ohRead, existsSync as _ohExists, mkdirSync as _ohMkdir };
