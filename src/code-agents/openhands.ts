/**
 * Round R4 (helper H52): OpenHands as a Timmy code agent, through the same execution contract as the other agents (a
 * cancellable job, .timmy/agents/<run>/, a sealed receipt, the endpoint rule, the change judge, /stop, recovery), isolated
 * in a container, with a local model only.
 *
 *   /agent openhands --local <task>
 *
 * Why a container: the OpenHands CLI (SDK v1.21.0, its own --help as read on the operator's Mac) runs the agent's
 * commands on the host with no sandbox, and its --headless mode approves every action itself. Timmy's other routes never
 * do that (Qwen Code runs with --approval-mode auto-edit, so its shell commands are not approved; Codex runs in its own
 * workspace-write sandbox). So Timmy runs the SDK itself, in a container of its own, on a copy of the project:
 *
 *   docker run --rm -i --pull never --name timmy-oh-<run> --label timmy.run=<run> --label timmy.project=<project id>
 *     --cpus 2 --memory 4g --pids-limit 512 --cap-drop ALL --security-opt no-new-privileges [--user <uid>:<gid>]
 *     --tmpfs /tmp/timmy-home:... --add-host host.docker.internal:host-gateway
 *     --mount type=bind,source=<project>/.timmy/agents/<run>/work,target=/work
 *     --mount type=bind,source=<project>/.timmy/agents/<run>/worker,target=/timmy,readonly
 *     --workdir /work -e HOME=/tmp/timmy-home -e LLM_BASE_URL=http://host.docker.internal:<port> -e LLM_MODEL=ollama/<model>
 *     -e LLM_API_KEY=ollama ... timmy-openhands:1.21.0 python /timmy/timmy_openhands.py
 *
 * the task on its stdin (workers/openhands/timmy_openhands.py reads it), JSON Lines back on its stdout. What is isolated
 * and what is not, as the route says at its start: only the copy is mounted (no .git, node_modules, .timmy or dist, the
 * folders Timmy's snapshot never compares), with the worker read-only; the model is this machine's Ollama; the
 * container CAN reach the network (it must reach that Ollama through host.docker.internal). The agent's changes reach
 * the project only through Timmy's write-back at its end (src/code-agents/openhands-run.ts), and only when it finished
 * and the project did not change meanwhile.
 *
 * ASSUMED, not checked by a run (no Docker and no OpenHands here; tests/openhands-agent.test.ts runs a FAKE docker): the docker
 * flags as Docker's CLI documents them (none is checked against a recorded `docker run --help`); that host-gateway reaches
 * the Mac's own 127.0.0.1:11434 under Rancher Desktop; that the SDK's names the worker reads (its default tool preset, the
 * conversation's options, its event classes) are the ones 1.21.0 has; that LiteLLM's `ollama/<model>` form drives tool
 * calls well enough without streaming. The Mac run checks each (the report of round R4, H52, lists them).
 */
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { projectId } from '../project/index.js';
import { tokenText } from './codex-local.js';
import {
  AGENTS_DIR, DEFAULT_BASE_URL, LOCAL_KEY_PLACEHOLDER, endpointClass, noteFile, scrubPaths,
  type AgentOutcome, type AgentPlan, type AgentProgress, type ChangeSet, type PlanResult,
} from './index.js';

type Env = Record<string, string | undefined>;
const set = (v: string | undefined): v is string => typeof v === 'string' && v.trim() !== '';

/** The route's key: its /tools row (`agent:openhands`) and the receipts that mark it exercised. */
export const OPENHANDS_ROUTE = 'openhands';
/** The OpenHands SDK and tools the image pins (workers/openhands/Dockerfile). */
export const OPENHANDS_SDK = '1.21.0';
export const OPENHANDS_IMAGE = `timmy-openhands:${OPENHANDS_SDK}`;
/** The label the Dockerfile sets; an image under the same tag without it was not built from that Dockerfile. */
export const OPENHANDS_IMAGE_LABEL = 'timmy.openhands.sdk';
export const OPENHANDS_WORKER = 'workers/openhands/timmy_openhands.py';
export const OPENHANDS_DOCKERFILE = 'workers/openhands/Dockerfile';
/** The one step that makes the image, run from Timmy's package root. Timmy never runs it itself. */
export const OPENHANDS_BUILD = `docker build -t ${OPENHANDS_IMAGE} -f ${OPENHANDS_DOCKERFILE} workers/openhands`;
/** The same step as /tools prints it (the Dockerfile is the folder's default one), short enough for its 80 columns. */
export const OPENHANDS_BUILD_SHORT = `docker build -t ${OPENHANDS_IMAGE} workers/openhands`;
export const CONTAINER_PREFIX = 'timmy-oh-';
export const LABEL_RUN = 'timmy.run';
export const LABEL_PROJECT = 'timmy.project';
/** The container's limits. */
export const OPENHANDS_LIMITS = { cpus: '2', memory: '4g', pids: 512 } as const;
/** The agent's steps (the SDK's iterations) when TIMMY_OPENHANDS_MAX_ITERATIONS does not say. */
export const OPENHANDS_MAX_ITERATIONS = 40;
export const CONTAINER_WORK = '/work';
export const CONTAINER_WORKER = '/timmy';
/** HOME inside the container: a tmpfs of its own (nothing of the host's home is mounted; it is gone with the container) */
export const CONTAINER_HOME = '/tmp/timmy-home';
/** The tools the worker gives the agent: the terminal and the file editor, nothing else. */
export const OPENHANDS_TOOLS = ['terminal', 'file_editor'] as const;
/** The copy is refused above this many bytes (the project's files, not .git, node_modules, .timmy or dist). */
export const OPENHANDS_COPY_MAX_BYTES = 2 * 1024 * 1024 * 1024;
/** Keys Timmy's environment may hold, blank in the docker client's (it forwards none, but no `-e NAME` could take one). */
export const OPENHANDS_BLANKED = ['OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'TIMMY_AGENT_API_KEY', 'LLM_API_KEY'] as const;
/** The docker client's own settings, taken from the environment Timmy runs the route with (which daemon, its config). */
export const DOCKER_CLIENT_ENV = ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY'] as const;
/** A model name Timmy passes on: Ollama's names (qwen3:4b, library/llama3, hf.co/org/repo:Q4_K_M). */
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,199}$/;

/** What the route words say, at /agent's start and in the Control Room: what is isolated, and what is not. */
export const OPENHANDS_NOTE = `In a container (${OPENHANDS_IMAGE}) on a copy of the project made for this run (no .git, node_modules, .timmy or dist): only that copy is mounted, with Timmy's worker read-only; the model is this machine's Ollama; the container can reach the network. Its changes are written into the project only when it finishes and the project has not changed meanwhile.`;
export const OPENHANDS_ONLY_LOCAL = 'OpenHands runs only on its local route: /agent openhands --local <task> (a model on this machine\'s Ollama, in a container on a copy of the project). Nothing was started.';
export const OPENHANDS_NO_PAID = 'OpenHands has no paid route in this round: Timmy runs it only with a model on this machine\'s Ollama (/agent openhands --local <task>). A paid route would send the task and the copy of the project to a remote model, and none has been checked. Nothing was started.';
export const OPENHANDS_NO_DOCKER = 'docker is not on PATH: OpenHands runs in a container (Rancher Desktop or Docker Desktop provides docker). Nothing was started.';
export const DOCKER_INSTALL = 'install Rancher Desktop or Docker Desktop (docker on PATH)';
/** Why /iterate does not take OpenHands (said by parseIterateLine). */
export const OPENHANDS_NOT_ITERATE = 'OpenHands is not an /iterate agent in this round: it works in a container on a copy, and its changes reach the project only through Timmy\'s write-back at its end, which no /iterate flow is wired to yet. /iterate runs qwen (Qwen Code) or codex (Codex with a local model). Nothing was started.';

/** The container a run of this route starts, as its plan names it. */
export interface OpenHandsContainer {
  name: string;
  image: string;
  labels: Record<string, string>;
  /** the run's folder, its copy of the project (mounted at /work) and its worker folder (mounted read-only at /timmy) */
  dir: string;
  work: string;
  worker: string;
  /** the run's token: the worker writes it into every line, and Timmy believes no line without it */
  token: string;
  maxIterations: number;
  /** what the container is told: its model, and where that Ollama is as the container sees it */
  llmBase: string;
  llmModel: string;
  /** `--user` (this process's uid:gid), when the platform has one */
  user?: string;
}

/** A mount as docker's --mount takes it: a CSV list, so a field with a comma or a quote is quoted (docker reads it with encoding/csv). */
export function bindMount(source: string, target: string, readonly = false): string {
  const field = (s: string): string => (/[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return ['type=bind', field(`source=${source}`), `target=${target}`, ...(readonly ? ['readonly'] : [])].join(',');
}

/** This machine's Ollama as the container reaches it: the same scheme, port and path (without /v1), at host.docker.internal. */
export function containerOllama(baseUrl: string): string | undefined {
  let u: URL;
  try { u = new URL(baseUrl); } catch { return undefined; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
  const path = u.pathname.replace(/\/+$/, '').replace(/\/v1$/i, '');
  return `${u.protocol}//host.docker.internal${u.port ? `:${u.port}` : ''}${path}`;
}

/** This process's uid:gid for --user, so the copy's files stay the user's own; undefined where there is none (Windows). */
export function hostUser(): string | undefined {
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  const gid = typeof process.getgid === 'function' ? process.getgid() : undefined;
  return uid !== undefined && gid !== undefined ? `${uid}:${gid}` : undefined;
}

/** The docker client's environment: its own settings from `env`, Timmy's keys blank. */
export function dockerClientEnv(env: Env): Record<string, string> {
  const out: Record<string, string> = Object.fromEntries(OPENHANDS_BLANKED.map((k) => [k, '']));
  for (const k of DOCKER_CLIENT_ENV) if (set(env[k])) out[k] = env[k]!.trim();
  return out;
}

/**
 * The docker command line of a run (everything after the program). Each flag is a docker CLI flag as Docker's reference
 * documents it; none is checked here against a recorded `docker run --help` (the Mac run checks them). Never --privileged,
 * never a host network, never the docker socket, never a key beyond the local placeholder.
 */
export function openHandsDockerArgs(c: Pick<OpenHandsContainer, 'name' | 'labels' | 'work' | 'worker' | 'llmBase' | 'llmModel' | 'maxIterations' | 'user'>): string[] {
  return [
    'run', '--rm', '-i',
    '--pull', 'never',                                   // the image is built by the operator, never pulled or built by Timmy
    '--name', c.name,
    ...Object.entries(c.labels).flatMap(([k, v]) => ['--label', `${k}=${v}`]),
    '--cpus', OPENHANDS_LIMITS.cpus,
    '--memory', OPENHANDS_LIMITS.memory,
    '--pids-limit', String(OPENHANDS_LIMITS.pids),
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    ...(c.user ? ['--user', c.user] : []),
    '--tmpfs', `${CONTAINER_HOME}:rw,nosuid,nodev,size=512m,mode=1777`,
    '--add-host', 'host.docker.internal:host-gateway',
    '--mount', bindMount(c.work, CONTAINER_WORK),
    '--mount', bindMount(c.worker, CONTAINER_WORKER, true),
    '--workdir', CONTAINER_WORK,
    '-e', `HOME=${CONTAINER_HOME}`,
    '-e', 'USER=timmy',
    '-e', `LLM_BASE_URL=${c.llmBase}`,
    '-e', `LLM_MODEL=${c.llmModel}`,
    '-e', `LLM_API_KEY=${LOCAL_KEY_PLACEHOLDER}`,
    '-e', `TIMMY_OPENHANDS_MAX_ITERATIONS=${c.maxIterations}`,
    '-e', 'LITELLM_LOCAL_MODEL_COST_MAP=True',            // LiteLLM's own price list, not one fetched from the network
    '-e', 'OPENHANDS_SUPPRESS_BANNER=1',
    '-e', 'PYTHONUNBUFFERED=1',
    '-e', 'PYTHONDONTWRITEBYTECODE=1',
    OPENHANDS_IMAGE,
    'python', `${CONTAINER_WORKER}/timmy_openhands.py`,
  ];
}

export interface OpenHandsInput {
  task: string;
  env: Env;
  run: string;
  bin: string;
  /** the project folder (given with --local) */
  root?: string;
  paid: boolean;
  local: boolean;
  wallTime: string;
  timeoutMs: number;
}

/**
 * The plan for `/agent openhands --local <task>`, or why nothing may start. The free rule is Qwen Code's (endpointClass):
 * a loopback endpoint (TIMMY_AGENT_BASE_URL, else 127.0.0.1:11434) and a model whose tag does not end in cloud. Anything
 * else is refused, and so is --paid (OPENHANDS_NO_PAID). Pure but for the project's id (its real folder's hash), the
 * process's uid and a fresh token: nothing is read from disk, written or contacted.
 */
export function planOpenHands(o: OpenHandsInput): PlanResult {
  if (o.paid) return { ok: false, refused: 'usage', error: OPENHANDS_NO_PAID };
  if (!o.local) return { ok: false, refused: 'usage', error: OPENHANDS_ONLY_LOCAL };
  if (!o.root) return { ok: false, refused: 'usage', error: 'OpenHands\' local route needs the project folder it works on. Nothing was started.' };
  if (/[\n\r\0]/.test(o.root)) return { ok: false, refused: 'setup', error: 'The project\'s folder name holds a line break or a NUL, which docker\'s --mount cannot take. Nothing was started.' };
  const env = o.env;
  const model = set(env.TIMMY_AGENT_MODEL) ? env.TIMMY_AGENT_MODEL.trim() : null;
  if (!model) return { ok: false, refused: 'setup', error: 'Set TIMMY_AGENT_MODEL to the model OpenHands should use on this machine\'s Ollama (a name from `ollama list`), then /agent openhands --local again. Nothing was started.' };
  if (!MODEL_NAME.test(model)) return { ok: false, refused: 'setup', error: `TIMMY_AGENT_MODEL (${model.slice(0, 40)}) is not a model name as Ollama lists them (letters, digits and . _ : / + -). Nothing was started.` };
  const baseUrl = set(env.TIMMY_AGENT_BASE_URL) ? env.TIMMY_AGENT_BASE_URL.trim() : DEFAULT_BASE_URL;
  const ep = endpointClass(baseUrl, model);
  if (ep.credentials) return { ok: false, refused: 'setup', error: 'TIMMY_AGENT_BASE_URL carries a user name or password; OpenHands\' local route takes none. Nothing was started.' };
  if (!ep.local) return { ok: false, refused: 'paid', error: `Remote, so it may cost money: ${ep.why}. OpenHands runs here only with a model on this machine's Ollama that is not a cloud model. Nothing was started.` };
  const llmBase = containerOllama(baseUrl);
  if (!llmBase) return { ok: false, refused: 'setup', error: 'TIMMY_AGENT_BASE_URL is not an http address of this machine\'s Ollama. Nothing was started.' };
  const given = env.TIMMY_OPENHANDS_MAX_ITERATIONS?.trim();
  const maxIterations = given ? Number(given) : OPENHANDS_MAX_ITERATIONS;
  if (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > 500) return { ok: false, refused: 'setup', error: `TIMMY_OPENHANDS_MAX_ITERATIONS is ${String(given).slice(0, 20)}: give a whole number from 1 to 500. Nothing was started.` };
  const dir = join(o.root, AGENTS_DIR, o.run);
  const user = hostUser();
  const container: OpenHandsContainer = {
    name: `${CONTAINER_PREFIX}${o.run}`, image: OPENHANDS_IMAGE, labels: { [LABEL_RUN]: o.run, [LABEL_PROJECT]: projectId(o.root) },
    dir, work: join(dir, 'work'), worker: join(dir, 'worker'), token: randomBytes(16).toString('hex'), maxIterations,
    llmBase, llmModel: `ollama/${model}`, ...(user ? { user } : {}),
  };
  const plan: AgentPlan = {
    agent: 'openhands', command: o.bin, args: openHandsDockerArgs(container), model, endpoint: 'local', where: ep.where,
    wallTime: o.wallTime, timeoutMs: o.timeoutMs, charge: 'local endpoint, no charge', costBasis: 'local endpoint',
    env: dockerClientEnv(env),
    // The task goes on the worker's stdin, with the run's token; never on the command line, so no process list shows it.
    stdinText: `${JSON.stringify({ v: 1, task: o.task.trim(), token: container.token })}\n`,
    container, note: OPENHANDS_NOTE,
  };
  return { ok: true, plan };
}

// ── its lines ───────────────────────────────────────────────────────────────────

/** The protocol's line types the parser reads (the worker's docstring lists their fields). */
export const OPENHANDS_LINES = ['started', 'action', 'observation', 'message', 'error', 'event', 'result'] as const;
const KNOWN: ReadonlySet<string> = new Set(OPENHANDS_LINES);
/** The file editor's commands that change a file (view does not). */
const EDITING: ReadonlySet<string> = new Set(['create', 'str_replace', 'insert', 'undo_edit', 'write']);
/** At most this many plain lines (docker's, Python's, the SDK's own on stderr) are shown in one run's progress. */
export const PLAIN_SHOWN = 200;
const NAMED_MAX = 20;
/** C0 and C1 controls (an escape sequence could redraw the terminal), and the bidirectional overrides. */
const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
/** The same set, for a test (no `g`: a global pattern keeps state between tests). */
const HAS_CONTROL = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
/** Terminal escape sequences, removed whole (CSI, OSC and the two-character ones), before any other control goes. */
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
/** The same, keeping line breaks and tabs: for a final message kept in a file. */
const CONTROLS_KEEP_LINES = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** One line of text for the terminal: no control character, whitespace collapsed, at most n characters. */
export function clean(v: string, n: number): string {
  const t = v.replace(ANSI, '').replace(CONTROLS, ' ').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

interface Seen {
  token: string;
  /** the result line was read; later lines are not */
  result: boolean;
  untrusted: boolean;
  after: boolean;
  plain: number;
  plainNoted: boolean;
  kinds: Set<string>;
  types: Set<string>;
  /** docker's own first error line ("docker: Error response from daemon: …"), scrubbed */
  dockerError?: string;
  /** what the worker's lines said */
  sdk?: string | null;
  tools?: string[];
  maxIterations?: number;
  status?: string;
  steps?: number;
  finished?: boolean;
  error?: string;
}
const watched = new WeakMap<AgentProgress, Seen>();

/** A run's progress, read with its token: lines without it are never believed (OPENHANDS_LINES). */
export function watchOpenHands(state: AgentProgress, token: string): void {
  watched.set(state, { token, result: false, untrusted: false, after: false, plain: 0, plainNoted: false, kinds: new Set(), types: new Set() });
}

/** What the run's lines said, for its record: the SDK version it reported, its status and steps, docker's error. */
export function openHandsSaid(state: AgentProgress): { sdk?: string | null; tools?: string[]; status?: string; steps?: number; finished?: boolean; maxIterations?: number; dockerError?: string; result: boolean } {
  const s = watched.get(state);
  if (!s) return { result: false };
  return {
    result: s.result,
    ...(s.sdk !== undefined ? { sdk: s.sdk } : {}), ...(s.tools ? { tools: [...s.tools] } : {}), ...(s.status ? { status: s.status } : {}),
    ...(s.steps !== undefined ? { steps: s.steps } : {}), ...(s.finished !== undefined ? { finished: s.finished } : {}),
    ...(s.maxIterations !== undefined ? { maxIterations: s.maxIterations } : {}), ...(s.dockerError ? { dockerError: s.dockerError } : {}),
  };
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const count = (v: unknown): number | undefined => { const n = num(v); return n !== undefined && Number.isInteger(n) && n >= 0 ? n : undefined; };

/**
 * A path the agent named, as the copy's (and so the project's) relative path: /work/<rel>, or a path relative to /work;
 * undefined for anything outside /work or climbing out of it.
 */
export function workRel(p: unknown): string | undefined {
  if (typeof p !== 'string') return undefined;
  const t = p.trim();
  let rel: string;
  if (t.startsWith(`${CONTAINER_WORK}/`)) rel = t.slice(CONTAINER_WORK.length + 1);
  else if (t && !t.startsWith('/') && !t.startsWith('~')) rel = t;
  else return undefined;
  const parts = rel.split('/').filter((x) => x && x !== '.');
  if (!parts.length || parts.some((x) => x === '..' || HAS_CONTROL.test(x))) return undefined;
  return parts.join('/');
}

/** How the worker said it did not finish, in words. */
function statusWords(status: string, ev: Record<string, unknown>, max?: number): string {
  const error = str(ev.error);
  switch (status) {
    case 'limit': return `its step limit${max ? ` (${max})` : ''} was reached`;
    case 'stuck': return 'the SDK found it stuck';
    case 'stopped': return 'it was stopped';
    case 'setup': return `it could not start${error ? `: ${clean(error, 200)}` : ''}`;
    case 'error': return `an error${error ? `: ${clean(error, 200)}` : ''}`;
    default: return `its status was ${status}${error ? ` (${clean(error, 160)})` : ''}`;
  }
}

/**
 * One line of the run's output: updates its progress and returns the line to show, or undefined. Only a JSON line with
 * this run's token is read (OPENHANDS_LINES); one without it is counted raw and named once, never believed: the agent's
 * own commands run in the same container, and a line can be forged (the token makes that hard, not impossible; what
 * changed is decided by Timmy's own comparison of the copy, never by these lines). A plain line (docker's, Python's) is
 * shown as it came, scrubbed, at most PLAIN_SHOWN of them. Nothing after the first result line is read.
 */
export function openHandsProgressLine(line: string, state: AgentProgress, root: string): string | undefined {
  const raw = line.trim();
  if (!raw) return undefined;
  let s = watched.get(state);
  if (!s) { watchOpenHands(state, ''); s = watched.get(state)!; }
  let ev: Record<string, unknown> | undefined;
  if (raw.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ev = parsed as Record<string, unknown>;
    } catch { /* plain text */ }
  }
  const say = (t: string, n = 120): string => clean(scrubPaths(t, root), n);
  if (!ev) {
    state.raw += 1;
    if (!s.dockerError && /^docker: /i.test(raw)) s.dockerError = say(raw, 240);
    if (s.plain >= PLAIN_SHOWN) {
      if (s.plainNoted) return undefined;
      s.plainNoted = true;
      return '(more plain lines: kept in the transcript)';
    }
    s.plain += 1;
    return say(raw, 200);
  }
  if (!s.token || ev.token !== s.token || ev.v !== 1) {
    state.raw += 1;
    if (s.untrusted) return undefined;
    s.untrusted = true;
    return 'a JSON line without this run\'s token: not believed (kept in the transcript)';
  }
  if (s.result) {
    state.raw += 1;
    if (s.after) return undefined;
    s.after = true;
    return 'a line after its result line: not read (kept in the transcript)';
  }
  const type = typeof ev.type === 'string' ? ev.type : '';
  if (!KNOWN.has(type)) {
    state.raw += 1;
    if (s.types.has(type) || s.types.size >= NAMED_MAX) return undefined;
    s.types.add(type);
    return `line  ${type ? clean(type, 40) : 'without a type'}: not one Timmy reads (kept in the transcript)`;
  }
  state.structured += 1;
  const tool = clean(str(ev.tool) ?? 'tool', 40);
  switch (type) {
    case 'started': {
      const sdk = str(ev.sdk);
      s.sdk = sdk ? clean(sdk, 40) : null;
      const tools = Array.isArray(ev.tools) ? ev.tools.filter((t): t is string => typeof t === 'string').map((t) => clean(t, 40)).slice(0, 8) : [];
      s.tools = tools;
      s.maxIterations = count(ev.max_iterations);
      const model = str(ev.model);
      if (model) state.model = clean(model, 120);
      if (s.sdk) state.version = `openhands-sdk ${s.sdk}`;
      const other = s.sdk && s.sdk !== OPENHANDS_SDK ? ` (not ${OPENHANDS_SDK}: rebuild the image)` : '';
      return `started  OpenHands SDK ${s.sdk ?? '(its version was not reported)'}${other}${model ? ` · model ${clean(model, 80)}` : ''}${tools.length ? ` · tools ${tools.join(', ')}` : ''}${s.maxIterations ? ` · up to ${s.maxIterations} steps` : ''}`;
    }
    case 'action': {
      state.toolCalls += 1;
      const command = str(ev.command);
      const path = str(ev.path);
      if (tool === 'file_editor') {
        const rel = path === undefined ? undefined : workRel(path);
        if (command && EDITING.has(command) && rel) noteFile(state, root, rel);
        return `tool  file_editor  ${clean(command ?? '?', 20)}${path !== undefined ? `  ${rel ?? '<outside the project copy>'}` : ''}`;
      }
      if (tool === 'terminal') return `tool  terminal  ${say(command ?? '', 80)}`;
      return `tool  ${clean(str(ev.name) ?? tool, 40)}`;
    }
    case 'observation': {
      const exit = num(ev.exit_code);
      if (ev.error === true) {
        state.toolErrors += 1;
        const excerpt = str(ev.excerpt);
        return `tool failed  ${tool}${exit !== undefined ? `  exit ${exit}` : ''}${excerpt ? `: ${say(excerpt, 120)}` : ''}`;
      }
      return tool === 'terminal' && exit !== undefined && exit !== 0 ? `tool  terminal  exit ${exit}` : undefined;
    }
    case 'message': {
      const text = str(ev.excerpt);
      if (!text?.trim()) return undefined;
      state.lastText = text.replace(ANSI, '').replace(CONTROLS_KEEP_LINES, '');
      return `says  ${say(text)}`;
    }
    case 'error': {
      state.toolErrors += 1;
      return `openhands error  ${say(str(ev.excerpt) ?? 'an error without a message', 160)}`;
    }
    case 'event': {
      const kind = clean(str(ev.kind) ?? 'an event', 40);
      if (s.kinds.has(kind) || s.kinds.size >= NAMED_MAX) return undefined;
      s.kinds.add(kind);
      return `event  ${kind}`;
    }
    default: { // result
      s.result = true;
      const finished = ev.finished === true;
      const status = clean(str(ev.status) ?? 'unknown', 40);
      s.status = status;
      s.finished = finished;
      s.steps = count(ev.steps);
      const max = count(ev.max_iterations) ?? s.maxIterations;
      const final = str(ev.final_message);
      if (final !== undefined && final.trim()) state.finalMessage = final.replace(ANSI, '').replace(CONTROLS_KEEP_LINES, '');
      state.reportedEnd = finished ? 'completed' : 'failed';
      if (!finished) { state.reportedError = `it did not finish: ${statusWords(status, ev, max)}`; s.error = state.reportedError; }
      const u = ev.usage && typeof ev.usage === 'object' ? ev.usage as Record<string, unknown> : undefined;
      const input = count(u?.input);
      const output = count(u?.output);
      if (input !== undefined || output !== undefined) state.usage = { input: input ?? 0, cached: 0, output: output ?? 0 };
      const steps = s.steps !== undefined ? ` · ${s.steps} step${s.steps === 1 ? '' : 's'}` : '';
      return `done  ${finished ? 'finished' : `not finished: ${statusWords(status, ev, max)}`}${steps}${state.usage ? ` · ${tokenText(state.usage)}` : ''}`;
    }
  }
}

/**
 * How a run ended, from its job's end and its own lines (index.ts judgeAgentRun asks this for OpenHands). `completed` only
 * from its result line saying finished at exit 0; the write-back may still turn it into failed (openhands-run.ts).
 */
export function judgeOpenHands(job: { state: string; exitCode?: number | null; signal?: string | null; error?: string }, progress: AgentProgress): { outcome: AgentOutcome; why: string } {
  const said = openHandsSaid(progress);
  if (job.state === 'cancelled') return { outcome: 'cancelled', why: 'stopped with /stop (or the REPL ended) before it finished' };
  if (job.error === 'timed out') return { outcome: 'timed out', why: 'Timmy\'s time limit ended it (its wall time and a grace period)' };
  if (job.state !== 'completed') {
    if (job.exitCode === 125) return { outcome: 'failed', why: `docker could not start its container (exit 125)${said.dockerError ? `: ${said.dockerError}` : ''}` };
    if (job.error) return { outcome: 'failed', why: job.error };
    if (progress.reportedError) return { outcome: 'failed', why: `${progress.reportedError} (exit ${job.exitCode ?? job.signal ?? '?'})` };
    return { outcome: 'failed', why: `it exited ${job.exitCode ?? job.signal ?? '?'}${said.result ? '' : ' without its result line'}` };
  }
  if (progress.reportedError) return { outcome: 'failed', why: `it exited 0 but ${progress.reportedError}` };
  if (progress.structured === 0) return { outcome: 'unknown', why: 'it exited 0 but reported nothing Timmy could read (no line with its token): whether it did the task is not known' };
  if (progress.reportedEnd !== 'completed') return { outcome: 'unknown', why: 'it exited 0, but it never gave its result line: whether it did the task is not known' };
  return { outcome: 'completed', why: 'it exited 0 and reported it finished' };
}

// ── its record ──────────────────────────────────────────────────────────────────

/** A stop of its container by its name and labels: what was found, what was run, and what is left. */
export interface ContainerStop {
  /** what asked for it: /stop, Timmy's time limit, the REPL's end, the check after a job that ended otherwise, recovery */
  why: 'stop' | 'time limit' | 'the REPL ended' | 'its job ended' | 'recovery';
  at: string;
  name: string;
  /** stopped: docker stop ended it; killed: docker kill did; gone: it was not running (or not there) by then; unresolved:
   *  still running after both; unchecked: docker could not be asked (detail); asked: under way when the record was written
   *  (container.json in the run's folder gets its end) */
  result: 'stopped' | 'killed' | 'gone' | 'unresolved' | 'unchecked' | 'asked';
  /** the docker commands run, each with its exit status */
  steps: Array<{ command: string; exit: number | null }>;
  detail?: string;
}

/** What Timmy wrote into the project from the copy, or why nothing was written. */
export interface WriteBack {
  state: 'written' | 'nothing to write' | 'refused' | 'partial' | 'not attempted';
  why: string;
  written: Array<{ path: string; how: 'added' | 'changed' | 'deleted'; sha256?: string | null; previous_sha256?: string | null; kept?: string }>;
  not_written: Array<{ path: string; why: string }>;
  /** the project's files that changed while it ran (a stale refusal names them): the first 20 */
  changed_meanwhile?: string[];
  changed_meanwhile_more?: number;
}

/** The run's own part of its record (run.json at its start, result.json at its end). */
export interface OpenHandsRecord {
  image: string;
  image_id?: string;
  container: { name: string; labels: Record<string, string> };
  /** the worker that ran: its copy in the run folder (mounted read-only) and that copy's sha256 */
  worker: { path: string; sha256: string };
  limits: { cpus: string; memory: string; pids: number; max_iterations: number };
  /** the copy: where it is (project-relative), how many files and bytes */
  copy: { path: string; files: number; bytes: number; kept?: boolean };
  /** what its lines said, at its end: the SDK version it reported (null: it did not say), its status and steps */
  reported?: { sdk: string | null; status?: string; steps?: number; tools?: string[] };
  /** what it changed in its copy */
  copy_changes?: ChangeSet & { truncated: boolean };
  writeback?: WriteBack;
  stop?: ContainerStop;
}

/** The write-back in a few words, for the end notice and /agent last. */
export function writeBackShort(w: WriteBack | undefined): string {
  if (!w) return '';
  const n = (k: WriteBack['written'][number]['how']): number => w.written.filter((x) => x.how === k).length;
  switch (w.state) {
    case 'written': return `written into the project (${n('added')} added, ${n('changed')} changed, ${n('deleted')} deleted)`;
    case 'nothing to write': return 'it changed nothing in its copy';
    case 'refused': return `not written: ${w.why}`;
    case 'partial': return `partly written: ${w.why}`;
    default: return `not written: ${w.why}`;
  }
}

// ── /agent, /tools and the Control Room ─────────────────────────────────────────

/** Its line in /agent's list: how it would run here, or what it needs. Nothing is contacted. */
export function openHandsSummary(env: Env): { text: string; ready: boolean } {
  const model = set(env.TIMMY_AGENT_MODEL) ? env.TIMMY_AGENT_MODEL.trim() : null;
  if (!model) return { text: '--local only: needs TIMMY_AGENT_MODEL (a model from ollama list); runs in a container', ready: false };
  const ep = endpointClass(set(env.TIMMY_AGENT_BASE_URL) ? env.TIMMY_AGENT_BASE_URL.trim() : DEFAULT_BASE_URL, model);
  if (!ep.local) return { text: `--local only: refused here: ${ep.why}`, ready: false };
  return { text: `--local only: model ${model} on this machine's Ollama (${ep.where}), in a container (${OPENHANDS_IMAGE}), no charge; the image is checked when it runs`, ready: true };
}

/** What the docker checks found (openhands-run.ts dockerSetup); `unchecked` when no check ran. */
export type OpenHandsDocker =
  | { state: 'ready'; server: string; imageId: string }
  | { state: 'no daemon' | 'no image' | 'other image' | 'docker failed' | 'unchecked'; detail?: string };

/**
 * Its /tools row (kind harness): installed only when docker is on PATH, its daemon answered, the image is there (built
 * from Timmy's Dockerfile: its label), the worker is in this Timmy and the model settings are local; "implemented; not
 * run" until a sealed, completed run of its own (exercisedBy agent:openhands).
 */
export function openHandsCapabilityRow(o: { env: Env; onPath: (bin: string) => boolean; docker: OpenHandsDocker; worker: boolean; exercisedAt?: string; packageRoot?: string }): {
  id: string; kind: 'harness'; name: string; rung: 'installed' | 'needs setup'; detail: string; setup?: string; exercisedBy: string;
} {
  const base = { id: OPENHANDS_ROUTE, kind: 'harness' as const, name: 'OpenHands, local model', exercisedBy: `agent:${OPENHANDS_ROUTE}` };
  const ran = o.exercisedAt ? 'ran here' : 'implemented; not run';
  if (!o.worker) return { ...base, rung: 'needs setup', detail: `${OPENHANDS_WORKER} is not in this Timmy; ${ran}`, setup: 'reinstall Timmy (its package lacks the OpenHands worker)' };
  if (!o.onPath('docker')) return { ...base, rung: 'needs setup', detail: `docker is not on PATH; ${ran}`, setup: DOCKER_INSTALL };
  const d = o.docker;
  if (d.state === 'no daemon') return { ...base, rung: 'needs setup', detail: `the Docker daemon did not answer; ${ran}`, setup: 'start Rancher Desktop (or Docker Desktop)' };
  const where = o.packageRoot ? ` in ${o.packageRoot}` : ' in Timmy\'s package root';
  if (d.state === 'no image') return { ...base, rung: 'needs setup', detail: `image ${OPENHANDS_IMAGE} not built: run the step${where}; ${ran}`, setup: OPENHANDS_BUILD_SHORT };
  if (d.state === 'other image') return { ...base, rung: 'needs setup', detail: `${OPENHANDS_IMAGE} here was not built from ${OPENHANDS_DOCKERFILE}: build it${where}; ${ran}`, setup: OPENHANDS_BUILD_SHORT };
  if (d.state === 'docker failed') return { ...base, rung: 'needs setup', detail: `docker did not answer as expected${d.detail ? ` (${d.detail})` : ''}; ${ran}`, setup: 'docker info shows what is wrong' };
  const model = set(o.env.TIMMY_AGENT_MODEL) ? o.env.TIMMY_AGENT_MODEL.trim() : null;
  if (!model) return { ...base, rung: 'needs setup', detail: `no local model named; ${ran}`, setup: 'set TIMMY_AGENT_MODEL to a model from ollama list' };
  const ep = endpointClass(set(o.env.TIMMY_AGENT_BASE_URL) ? o.env.TIMMY_AGENT_BASE_URL.trim() : DEFAULT_BASE_URL, model);
  if (!ep.local) return { ...base, rung: 'needs setup', detail: `not local: ${ep.why}; ${ran}`, setup: 'a non-cloud TIMMY_AGENT_MODEL on 127.0.0.1 (TIMMY_AGENT_BASE_URL)' };
  if (d.state === 'unchecked') return { ...base, rung: 'installed', detail: `docker on PATH; its daemon and image were not checked here; ${ran}` };
  return {
    ...base, rung: 'installed',
    detail: o.exercisedAt
      ? `/agent openhands --local <task>: a job in a container (${OPENHANDS_IMAGE}); free on this machine's Ollama (${model})`
      : `implemented; not run: /agent openhands --local <task>, in a container (${OPENHANDS_IMAGE}), free on this machine's Ollama (${model})`,
  };
}

/** The Control Room's route words for a run of this route, from its record. */
export function openHandsRouteWords(r: { endpoint?: unknown; openhands?: unknown }): string {
  const image = r.openhands && typeof r.openhands === 'object' && typeof (r.openhands as { image?: unknown }).image === 'string' ? (r.openhands as { image: string }).image : OPENHANDS_IMAGE;
  const local = r.endpoint === 'local' ? 'local endpoint, no charge' : 'route not recorded';
  return `${local}; in a container (${clean(image, 60)}): only a copy of the project is mounted, the network is reachable, the model is this machine's Ollama`;
}
