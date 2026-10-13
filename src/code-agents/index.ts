/**
 * Code agents from the REPL (round R3, /agent): Qwen Code, Claude Code, Codex and OpenCode run headless in
 * the active project as Timmy jobs, each run with its own operation ID (the run id) kept in its job label, its
 * run folder (.timmy/agents/<run>/), its result and its receipt.
 *
 * Every command line below is built from the CLIs' own --help texts as captured on the operator's Mac
 * (qwen 0.25.0, Claude Code 2.1.251, codex-cli 0.153.2 (round R4; its `codex exec --help` is byte for byte the text
 * recorded in R3 as 0.140.0's), opencode 1.18.31); each flag cites the line it
 * relies on. Nothing here decides that a run is free except the endpoint rule (endpointClass): Qwen Code on a
 * loopback OpenAI-compatible endpoint with a model whose tag does not end in ":cloud", and (round R4, H25)
 * Codex's local route, `/agent codex --local`, under the same rule (codex-local.ts). Everything else may
 * cost money and runs only when the operator's line says --paid. A cloud-backed model tag remains cloud.
 */
import { createHash, randomBytes } from 'node:crypto';
import { accessSync, appendFileSync, closeSync, constants as fsConstants, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { CODEX_LOCAL_ROUTE, codexProgressLine, planCodexLocal } from './codex-local.js';
// Round R4 (helper H52): OpenHands, in a container with a local model only (openhands.ts); hooks are marked "R4 (H52)".
import { judgeOpenHands, openHandsProgressLine, planOpenHands, type OpenHandsContainer, type OpenHandsRecord } from './openhands.js';
import { cancelledWhy } from '../utils/stop-words.js';

export type AgentName = 'qwen' | 'claude' | 'codex' | 'opencode' | 'openhands';
export const AGENT_NAMES: readonly AgentName[] = ['qwen', 'claude', 'codex', 'opencode', 'openhands'];

export interface AgentInfo {
  /** what it is called */
  title: string;
  /** the program on PATH */
  bin: string;
  /** an environment variable that names another program to run instead (tests, or a program off PATH) */
  binEnv: string;
  /** its /tools row (src/capabilities): marked exercised only by its own completed runs (agent:<name>) */
  harnessId: string;
  /** the environment variable that picks its model, when one may be picked */
  modelEnv: string;
  /** how its output is read */
  stream: 'claude-stream' | 'codex-json' | 'opencode-json' | 'openhands-jsonl';
  /**
   * Run by the name the PATH gives it, its links not followed: a multi-call program chooses what it is by the name it is
   * called (OrbStack's docker is a link to `docker-tools`, which refused to run under that name: ledger row 159).
   */
  asNamed?: true;
}

export const AGENTS: Readonly<Record<AgentName, AgentInfo>> = {
  qwen: { title: 'Qwen Code', bin: 'qwen', binEnv: 'TIMMY_AGENT_QWEN_BIN', harnessId: 'qwen-code', modelEnv: 'TIMMY_AGENT_MODEL', stream: 'claude-stream' },
  claude: { title: 'Claude Code', bin: 'claude', binEnv: 'TIMMY_AGENT_CLAUDE_BIN', harnessId: 'claude-code', modelEnv: 'TIMMY_AGENT_CLAUDE_MODEL', stream: 'claude-stream' },
  codex: { title: 'Codex', bin: 'codex', binEnv: 'TIMMY_AGENT_CODEX_BIN', harnessId: 'codex', modelEnv: 'TIMMY_AGENT_CODEX_MODEL', stream: 'codex-json' },
  opencode: { title: 'OpenCode', bin: 'opencode', binEnv: 'TIMMY_AGENT_OPENCODE_BIN', harnessId: 'opencode', modelEnv: 'TIMMY_AGENT_OPENCODE_MODEL', stream: 'opencode-json' },
  // R4 (H52): the program Timmy runs is docker (the SDK runs inside Timmy's container); its model is the local one.
  openhands: { title: 'OpenHands', bin: 'docker', binEnv: 'TIMMY_AGENT_DOCKER_BIN', harnessId: 'openhands', modelEnv: 'TIMMY_AGENT_MODEL', stream: 'openhands-jsonl', asNamed: true },
};

/** Qwen Code's endpoint when TIMMY_AGENT_BASE_URL is not set: a local Ollama's OpenAI-compatible API. */
export const DEFAULT_BASE_URL = 'http://127.0.0.1:11434/v1';
/** The key sent to a local endpoint when TIMMY_AGENT_API_KEY is not set (Ollama ignores it; it is not a secret). */
export const LOCAL_KEY_PLACEHOLDER = 'ollama';
export const DEFAULT_WALL_TIME = '15m';
/** Timmy's own limit is the agent's wall time plus this, so the agent's own budget normally ends it first. */
export const DEFAULT_GRACE_MS = 30_000;
/** How much of the agent's final message is kept in its result. */
export const FINAL_MESSAGE_MAX = 8_000;
/** Where a project keeps its agent runs. */
export const AGENTS_DIR = '.timmy/agents';
/** qwen --help: "--max-wall-time ... Aborts the run with exit code 55 when exceeded." */
export const QWEN_BUDGET_EXIT = 55;

type Env = Record<string, string | undefined>;
const set = (v: string | undefined): v is string => typeof v === 'string' && v.trim() !== '';

/** The program /agent would run for this agent: its override, else the one on PATH, else null. */
export function agentBin(name: AgentName, env: Env, onPath: (cmd: string) => string | null): string | null {
  const info = AGENTS[name];
  const override = env[info.binEnv];
  if (set(override)) return override.trim();
  const found = onPath(info.bin);
  // A program run by its name: the PATH's own entry for it (a link kept as a link), where onPath found it on that PATH.
  return found && info.asNamed ? pathEntry(info.bin, env) ?? found : found;
}

/** The first entry of env's PATH that holds an executable `bin`, as that PATH names it: links are not followed. */
export function pathEntry(bin: string, env: Env): string | null {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    try { accessSync(join(dir, bin), fsConstants.X_OK); return join(dir, bin); } catch { /* not here */ }
  }
  return null;
}

// ── the endpoint rule ──────────────────────────────────────────────────────────

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export interface EndpointClass {
  local: boolean;
  /** host[:port] only: never the path, a user or a key */
  where: string;
  /** the address carries a user name or password: refused whatever --paid says */
  credentials?: true;
  /** why it is remote, in a sentence (absent when local) */
  why?: string;
}

/**
 * Local, and so no charge, ONLY when the base URL's host is 127.0.0.1, localhost or ::1 AND the model tag
 * does not end in ":cloud" (Ollama sends a :cloud model to its cloud: AGENTS.md §8, a cloud-backed model
 * tag remains cloud). Anything else is remote and treated as paid.
 */
export function endpointClass(baseUrl: string, model: string | undefined): EndpointClass {
  let url: URL;
  try { url = new URL(baseUrl); } catch { return { local: false, where: 'an address that does not parse', why: `${baseUrl.slice(0, 40)} is not a URL` }; }
  const where = url.host || url.hostname;
  // A user name or password in the address would sit on the command line and in the saved job (the review of
  // ee70b9e, M10): refused here, so neither a local nor a paid run takes it; a key belongs in TIMMY_AGENT_API_KEY.
  if (url.username || url.password) return { local: false, where, why: 'the address carries a user name or password: put the key in TIMMY_AGENT_API_KEY instead', credentials: true };
  if (!LOOPBACK.has(url.hostname.toLowerCase())) return { local: false, where, why: `${where} is not this machine` };
  // Ollama names its cloud models with a tag ending in "cloud": `glm-5.3:cloud`, and also `gpt-oss:120b-cloud`
  // (the independent review of ee70b9e: only ":cloud" was caught). Any tag ending in cloud after a separator counts.
  if (model && /(?:^|[:\-_.])cloud$/i.test(model.trim())) return { local: false, where, why: `${model.trim()} is a cloud model (its tag ends in cloud): the endpoint on this machine sends it to a cloud` };
  return { local: true, where };
}

// ── the plan: one command line per agent, from its help text ─────────────────────

export interface AgentPlan {
  agent: AgentName;
  /** the program and its arguments (the task is the last argument) */
  command: string;
  args: string[];
  model: string | null;
  endpoint: 'local' | 'remote';
  /** host[:port] for Qwen Code; for an account agent, whose account it uses */
  where: string;
  /** a sentence: why this run costs nothing, or that it may cost money */
  charge: string;
  /** cost_basis in the result when the cost is 0 */
  costBasis: 'local endpoint' | 'reported by the agent' | 'unknown';
  /** the wall time asked of the agent, and Timmy's own limit for the job */
  wallTime: string;
  timeoutMs: number;
  /** R4 (H62): the job's own limit when it is not timeoutMs: OpenHands' layer stops its container at timeoutMs, and the
   *  job's own limit, this, later, stays as the backstop (openhands.ts OPENHANDS_BACKSTOP_MS) */
  jobTimeoutMs?: number;
  /** Codex writes its last message here (project-relative), from its -o flag */
  lastMessageFile?: string;
  /** added to the agent's environment: HOME from TIMMY_AGENT_HOME, so its settings and records stay out of the user's own */
  env?: Record<string, string>;
  /**
   * Round R4 (H25): Codex's local route (codex exec --oss): the Ollama it is pointed at and the model, which that
   * endpoint must already list before the run starts (codex-local.ts codexLocalPreflight).
   */
  oss?: { provider: 'ollama'; baseUrl: string; model: string };
  /** folders made just before the run starts (Codex's own CODEX_HOME under TIMMY_AGENT_HOME) */
  makeDirs?: string[];
  /**
   * Round R4 (H25): 'closed': the job's stdin is ended at its start (JobSpec.stdin). codex-exec-help.txt: "If stdin is
   * piped and a prompt is also provided, stdin is appended as a `<stdin>` block": with the job's pipe left open, nothing
   * would ever end it and Codex would wait for it until Timmy's time limit.
   */
  stdin?: 'closed';
  /** one sentence the operator is told at the start: what the run is given, and what it is not */
  note?: string;
  /** R4 (H52): written to the job's stdin at its start, which is then ended (OpenHands' worker reads its task there) */
  stdinText?: string;
  /** R4 (H52): OpenHands' container: its name, labels and image, the copy and the worker it mounts (openhands.ts) */
  container?: OpenHandsContainer;
}

export type PlanResult = { ok: true; plan: AgentPlan } | { ok: false; error: string; refused: 'setup' | 'paid' | 'usage' };

/** A duration as qwen's --max-wall-time takes it (`90`, `30s`, `5m`, `1h`, `1.5h`), in ms; null when it is not one. */
export function wallTimeMs(text: string): number | null {
  const m = text.trim().match(/^(\d+(?:\.\d+)?)(s|m|h)?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? 's').toLowerCase();
  const ms = n * (unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : 1000);
  return ms >= 1000 ? Math.round(ms) : null;
}

/** A task that begins with "-" would be read as an option: it is given as "Task: …" instead. */
export const taskArg = (task: string): string => (task.trimStart().startsWith('-') ? `Task: ${task.trim()}` : task.trim());

/**
 * `local` (round R4, H25): the agent's free local route, `/agent <name> --local`: only Codex has one (codex-local.ts),
 * and it needs `root`, the project folder it works in. It takes no --paid.
 */
export function planAgent(name: AgentName, task: string, o: { env: Env; paid: boolean; run: string; bin: string; local?: boolean; root?: string }): PlanResult {
  const env = o.env;
  const info = AGENTS[name];
  if (!task.trim()) return { ok: false, refused: 'usage', error: `Say what ${info.title} should do: /agent ${name} <task>` };
  const wallTime = set(env.TIMMY_AGENT_WALL_TIME) ? env.TIMMY_AGENT_WALL_TIME.trim() : DEFAULT_WALL_TIME;
  const wallMs = wallTimeMs(wallTime);
  if (wallMs === null) return { ok: false, refused: 'setup', error: `TIMMY_AGENT_WALL_TIME is ${wallTime.slice(0, 20)}: give seconds or a duration like 90s, 15m or 1h. Nothing was started.` };
  const grace = Number(env.TIMMY_AGENT_GRACE_MS);
  const timeoutMs = wallMs + (Number.isFinite(grace) && grace >= 0 ? grace : DEFAULT_GRACE_MS);
  const model = set(env[info.modelEnv]) ? env[info.modelEnv]!.trim() : null;
  const prompt = taskArg(task);
  // TIMMY_AGENT_HOME: the agent runs with this HOME (qwen 0.25.0 was seen writing ~/.qwen even with --bare and no
  // chat recording). For an account agent it also hides its login, so it is for a sandboxed run.
  const home = set(env.TIMMY_AGENT_HOME) ? { env: { HOME: env.TIMMY_AGENT_HOME.trim() } } : {};
  // R4 (H52): OpenHands has its local route only, in a container; --paid is refused (openhands.ts planOpenHands).
  if (name === 'openhands') return planOpenHands({ task, env, run: o.run, bin: o.bin, ...(o.root ? { root: o.root } : {}), paid: o.paid, local: o.local === true, wallTime, timeoutMs });
  if (o.local) {
    if (name === 'qwen') return { ok: false, refused: 'usage', error: 'Qwen Code has no --local: it runs free whenever its endpoint is on this machine (/agent qwen <task>). Nothing was started.' };
    if (name !== 'codex') return { ok: false, refused: 'usage', error: `${info.title} has no local route: it runs on your own account (/agent ${name} --paid <task>). Nothing was started.` };
    if (o.paid) return { ok: false, refused: 'usage', error: 'Codex\'s local route (--local) runs on this machine for free and takes no --paid: /agent codex --local <task>, or /agent codex --paid <task> on your own account. Nothing was started.' };
    if (!o.root) return { ok: false, refused: 'usage', error: 'Codex\'s local route needs the project folder it works in. Nothing was started.' };
    return planCodexLocal({ task, prompt, env, run: o.run, bin: o.bin, root: o.root, wallTime, timeoutMs });
  }
  if (name === 'qwen') {
    if (!model) {
      return { ok: false, refused: 'setup', error: 'Set TIMMY_AGENT_MODEL to the model Qwen Code should use (for a local Ollama, a name from `ollama list`), then /agent qwen again. Nothing was started.' };
    }
    const baseUrl = set(env.TIMMY_AGENT_BASE_URL) ? env.TIMMY_AGENT_BASE_URL.trim() : DEFAULT_BASE_URL;
    const ep = endpointClass(baseUrl, model);
    const key = set(env.TIMMY_AGENT_API_KEY) ? env.TIMMY_AGENT_API_KEY.trim() : ep.local ? LOCAL_KEY_PLACEHOLDER : null;
    if (ep.credentials) return { ok: false, refused: 'setup', error: `TIMMY_AGENT_BASE_URL carries a user name or password; ${ep.why}. Nothing was started.` };
    if (!ep.local && !o.paid) {
      return { ok: false, refused: 'paid', error: `Remote, so it may cost money: ${ep.why}. It would send the task, and the project files Qwen Code reads, to ${ep.where}. Nothing was started. To run it anyway: /agent qwen --paid <task>` };
    }
    if (!key) return { ok: false, refused: 'setup', error: `Set TIMMY_AGENT_API_KEY for ${ep.where} (a remote endpoint), then /agent qwen --paid again. Nothing was started.` };
    // Every flag below is from qwen-help.txt (qwen 0.25.0). The key is NOT a flag: on the command line it would show
    // in the process list and in the job's saved record. It goes in OPENAI_API_KEY, the child's environment only;
    // round R3 checked that qwen 0.25.0 with --bare and --auth-type openai sends that variable as its bearer token
    // when --openai-api-key is absent (against a local fake server). Set even for a local endpoint, so a real
    // OPENAI_API_KEY in Timmy's own environment is never handed to the endpoint instead.
    const args = [
      '--bare',                              // "--bare  Minimal mode: skip implicit startup auto-discovery and only honor explicitly provided CLI inputs."
      '--auth-type', 'openai',               // "--auth-type  Authentication type  [choices: "openai", ...]"
      '--openai-base-url', baseUrl,          // "--openai-base-url  OpenAI base URL (for custom endpoints)"
      '-m', model,                           // "-m, --model  Model"
      '--approval-mode', 'auto-edit',        // "auto-edit (Automatically approve file edits)": shell commands are not auto-approved
      '-o', 'stream-json',                   // "-o, --output-format  The format of the CLI output. [choices: "text", "json", "stream-json"]"
      '--max-wall-time', wallTime,           // "--max-wall-time  Run-level wall-clock budget ... Aborts the run with exit code 55 when exceeded."
      '--chat-recording=false',              // "--chat-recording  Enable chat recording to disk. If false, chat history is not saved"
      prompt,                                // "query  Positional prompt. Defaults to one-shot"
    ];
    return {
      ok: true,
      plan: {
        agent: name, command: o.bin, args, model, endpoint: ep.local ? 'local' : 'remote', where: ep.where, wallTime, timeoutMs,
        // Timmy's own keys are not the agent's: blanked in its environment (the review of ee70b9e, M9).
        env: { ...(home.env ?? {}), OPENAI_API_KEY: key, OPENROUTER_API_KEY: '', TIMMY_AGENT_API_KEY: '' },
        charge: ep.local ? 'local endpoint, no charge' : `remote endpoint ${ep.where}: may cost money (--paid)`,
        costBasis: ep.local ? 'local endpoint' : 'unknown',
      },
    };
  }
  // The account agents: each runs on the user's own account, so each may cost money.
  if (!o.paid) {
    return { ok: false, refused: 'paid', error: `${info.title} runs on your own account and costs money. Nothing was started. To run it anyway: /agent ${name} --paid <task>` };
  }
  const base = { agent: name, command: o.bin, model, endpoint: 'remote' as const, wallTime, timeoutMs, costBasis: 'unknown' as const, charge: `your ${info.title} account: costs money (--paid)`, ...home };
  if (name === 'claude') {
    // Every flag below is from claude-help.txt (Claude Code 2.1.251):
    const args = [
      '-p',                                  // "-p, --print  Print response and exit (useful for pipes)"
      '--output-format', 'stream-json',      // "--output-format <format>  Output format (only works with --print): ... "stream-json" (realtime streaming)"
      '--verbose',                           // "--verbose  Override verbose mode setting from config" (stream-json printing has asked for it; see the report)
      '--permission-mode', 'acceptEdits',    // "--permission-mode <mode> ... (choices: "acceptEdits", ...)": edits allowed, nothing bypassed
      '--no-session-persistence',            // "--no-session-persistence  Disable session persistence ... (only works with --print)"
      '--strict-mcp-config',                 // "--strict-mcp-config  Only use MCP servers from --mcp-config": none is given, so none
      ...(model ? ['--model', model] : []),  // "--model <model>  Model for the current session"
      prompt,                                // "prompt  Your prompt"
    ];
    return { ok: true, plan: { ...base, args, where: 'your Claude account', costBasis: 'reported by the agent' } };
  }
  if (name === 'codex') {
    const last = `${AGENTS_DIR}/${o.run}/codex-last-message.txt`;
    // Every flag below is in codex-exec-help.txt (codex-cli 0.153.2, rechecked in round R4):
    const args = [
      'exec',                                // "codex exec  Run Codex non-interactively"
      '--json',                              // "--json  Print events to stdout as JSONL"
      '--sandbox', 'workspace-write',        // "-s, --sandbox <SANDBOX_MODE> ... [possible values: read-only, workspace-write, danger-full-access]"
      '--skip-git-repo-check',               // "--skip-git-repo-check  Allow running Codex outside a Git repository"
      '--ephemeral',                         // "--ephemeral  Run without persisting session files to disk"
      '-o', last,                            // "-o, --output-last-message <FILE>  Specifies file where the last message from the agent should be written"
      ...(model ? ['-m', model] : []),       // "-m, --model <MODEL>  Model the agent should use"
      prompt,                                // "[PROMPT]  Initial instructions for the agent"
    ];
    // Round R4 (H25): stdin closed at the start, as for the local route (AgentPlan.stdin); the command line is unchanged.
    return { ok: true, plan: { ...base, args, where: 'your OpenAI account', lastMessageFile: last, stdin: 'closed' } };
  }
  // opencode: every flag below is from opencode-run-help.txt (opencode 1.18.31):
  const args = [
    'run',                                   // "opencode run [message..]  run opencode with a message"
    '--format', 'json',                      // "--format  format: default (formatted) or json (raw JSON events)"
    '--pure',                                // "--pure  run without external plugins"
    ...(model ? ['-m', model] : []),         // "-m, --model  model to use in the format of provider/model"
    prompt,                                  // "message  message to send"
  ];
  return { ok: true, plan: { ...base, args, where: 'the account of its configured provider', costBasis: 'reported by the agent' } };
}

/**
 * `/agent <name> [--paid | --local] <task…>`: the agent, the task and whether the line says --paid (or, since round
 * R4, --local: Codex's local route). Only the options right after the agent's name count, each once and in either
 * order, and the task is the rest exactly as typed: "--paid" or "--local" inside a task's own words neither authorizes
 * spending, nor picks a route, nor disappears from the task (the review of ee70b9e).
 */
export function parseAgentLine(line: string): { name?: AgentName; word?: string; paid: boolean; local?: true; task: string } {
  const words = line.trim().split(/\s+/).filter(Boolean);
  const word = words[0];
  const name = AGENT_NAMES.find((n) => n === word?.toLowerCase());
  let task = line.trim().slice(word ? word.length : 0).trim();
  let paid = false;
  let local = false;
  for (let lead = /^--(paid|local)(?=\s|$)/.exec(task); lead; lead = /^--(paid|local)(?=\s|$)/.exec(task)) {
    if (lead[1] === 'paid' ? paid : local) break;
    if (lead[1] === 'paid') paid = true; else local = true;
    task = task.slice(lead[0].length).trim();
  }
  return { ...(name ? { name } : {}), ...(word ? { word } : {}), paid, ...(local ? { local: true as const } : {}), task };
}

export const newRunId = (): string => `a${randomBytes(4).toString('hex')}`;

// ── the label: no absolute path, the first words of the task ─────────────────────

/** Free text with the project's folder as "." and the home folder as "~". */
export function scrubPaths(text: string, root: string): string {
  let out = text;
  const roots = [root];
  try { roots.push(realpathSync(root)); } catch { /* gone */ }
  // A folder is replaced only where it ends at a path boundary: with root /a/proj, /a/proj2/x stays as it is.
  const boundary = '(?=$|[\\\\/\\s"\'`)\\]},:;])';
  const at = (s: string, dir: string, as: string): string => s.replace(new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + boundary, 'g'), as);
  for (const r of [...new Set(roots)].sort((a, b) => b.length - a.length)) if (r.length > 1) out = at(out, r, '.');
  const home = homedir();
  if (home.length > 1) out = at(out, home, '~');
  return out;
}

/** The first words of a task for a label: its paths scrubbed, any other absolute path named only as <path>. */
export function taskWords(task: string, root: string, max = 48): string {
  const clean = scrubPaths(task, root).replace(/\s+/g, ' ').trim().replace(/(^|\s)\/\S+/g, '$1<path>');
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const at = cut.lastIndexOf(' ');
  return `${(at > 20 ? cut.slice(0, at) : cut).trim()}…`;
}

export const agentLabel = (name: AgentName, run: string, task: string, root: string): string => `agent ${name} ${run}: ${taskWords(task, root)}`;

// ── snapshots: what the project's files are, before and after ───────────────────

/**
 * A file, or a symbolic link (the review of ee70b9e, M1): a link is kept as its exact link text and that text's
 * sha256 (AGENTS.md §6: compare link text, never the target it leads to). Its target is never read or followed.
 */
export interface SnapFile { size: number; sha256: string | null; mtimeMs: number; link?: string }
export type Snapshot = Map<string, SnapFile>;
/** Never looked into: version control, dependencies, Timmy's own records, build output. */
export const SNAPSHOT_SKIP = new Set(['.git', 'node_modules', '.timmy', 'dist']);
export const SNAPSHOT_MAX_FILES = 20_000;
/** A larger file is compared by its size and time, not hashed. */
export const SNAPSHOT_HASH_LIMIT = 64 * 1024 * 1024;

const hashFile = (path: string): string => {
  const h = createHash('sha256');
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(1024 * 1024);
    for (;;) { const n = readSync(fd, buf, 0, buf.length, null); if (!n) break; h.update(buf.subarray(0, n)); }
  } finally { closeSync(fd); }
  return h.digest('hex');
};

/** Every regular file of the project (project-relative, "/" separated), its size and sha256; no link is followed. */
export function snapshotProject(root: string): { files: Snapshot; truncated: boolean } {
  const files: Snapshot = new Map();
  let truncated = false;
  const walk = (dir: string, rel: string): void => {
    let names: string[];
    try { names = readdirSync(dir).sort(); } catch { return; }
    for (const n of names) {
      if (files.size >= SNAPSHOT_MAX_FILES) { truncated = true; return; }
      if (SNAPSHOT_SKIP.has(n)) continue;
      const abs = join(dir, n);
      const r = rel ? `${rel}/${n}` : n;
      let st;
      try { st = lstatSync(abs); } catch { continue; }
      if (st.isDirectory()) walk(abs, r);
      else if (st.isSymbolicLink()) {
        let link = '';
        try { link = readlinkSync(abs); } catch { link = ''; }
        files.set(r, { size: Buffer.byteLength(link), sha256: createHash('sha256').update(`symlink\0${link}`).digest('hex'), mtimeMs: st.mtimeMs, link });
      } else if (st.isFile()) {
        let sha: string | null = null;
        if (st.size <= SNAPSHOT_HASH_LIMIT) { try { sha = hashFile(abs); } catch { sha = null; } }
        files.set(r, { size: st.size, sha256: sha, mtimeMs: st.mtimeMs });
      }
    }
  };
  walk(root, '');
  return { files, truncated };
}

export interface FileChange { path: string; size: number; sha256: string | null; previous_sha256?: string | null; previous_size?: number; link?: string; previous_link?: string }
export interface ChangeSet { added: FileChange[]; changed: FileChange[]; deleted: FileChange[] }

export function diffSnapshots(before: Snapshot, after: Snapshot): ChangeSet {
  const out: ChangeSet = { added: [], changed: [], deleted: [] };
  for (const [path, a] of after) {
    const b = before.get(path);
    const links = { ...(a.link !== undefined ? { link: a.link } : {}) };
    if (!b) { out.added.push({ path, size: a.size, sha256: a.sha256, ...links }); continue; }
    const differs = a.link !== b.link || (a.sha256 && b.sha256 ? a.sha256 !== b.sha256 : a.size !== b.size || a.mtimeMs !== b.mtimeMs);
    if (differs) out.changed.push({ path, size: a.size, sha256: a.sha256, previous_sha256: b.sha256, previous_size: b.size, ...links, ...(b.link !== undefined ? { previous_link: b.link } : {}) });
  }
  for (const [path, b] of before) if (!after.has(path)) out.deleted.push({ path, size: 0, sha256: null, previous_sha256: b.sha256, previous_size: b.size, ...(b.link !== undefined ? { previous_link: b.link } : {}) });
  return out;
}

// ── the /iterate check's snapshot (round R4, the review's R4-2) ──────────────────

/**
 * What /iterate does not look into, for size: entries named .git or node_modules, at any depth. Never skipped silently:
 * each one found is named in the agent run's result, and in the flow's record and end line.
 */
export const JUDGE_SKIP = new Set(['.git', 'node_modules']);
/** The /iterate check covers .timmy and dist too, so it compares up to this many files (/agent's own snapshot: 20,000). */
export const JUDGE_MAX_FILES = 100_000;
/** At most this many entries not looked into are named; the rest are counted. */
export const NOT_COMPARED_MAX = 20;
/** What the /iterate check compares, in a sentence (on the agent run's result and the flow's record). */
export const JUDGE_SCOPE = 'every file of the project at any depth, .timmy and dist included, except Timmy\'s own writes during the agent step (own) and the folders named .git or node_modules (not_compared, not looked into for size)';

/** One walk of the /iterate check: the files, whether the walk stopped at JUDGE_MAX_FILES, and the entries not looked into. */
export interface JudgedSnapshot { files: Snapshot; truncated: boolean; notCompared: string[] }

/** What the /iterate check of an agent run saw (R4-2): kept on the run's result as `judged`. */
export interface JudgedChanges {
  scope: string;
  files: ChangeSet & { truncated: boolean };
  /** Timmy's own writes during the agent step, not counted: project-relative folders, each ending in / */
  own: string[];
  /** the entries not looked into (named .git or node_modules), before or after the run: the first NOT_COMPARED_MAX */
  not_compared: string[];
  /** how many more such entries there were than are named */
  not_compared_more?: number;
}

/** What a flow's record keeps of the check: its scope, Timmy's own writes left out, the entries not looked into. */
export type ComparedScope = Omit<JudgedChanges, 'files'>;

/**
 * The snapshot /iterate judges an agent's run by (R4-2): every regular file and link of the project at any depth, .timmy
 * and dist included, except the folders in `own` (Timmy's own writes during the agent step, project-relative) and, for
 * size, every entry named .git or node_modules, each one listed in notCompared (a folder with a trailing /). No link is
 * followed; a link is kept as its link text, as snapshotProject keeps it.
 */
export function judgeSnapshot(root: string, own: readonly string[]): JudgedSnapshot {
  const files: Snapshot = new Map();
  const notCompared: string[] = [];
  const skipOwn = new Set(own.map((o) => o.replace(/\/+$/, '')));
  let truncated = false;
  const walk = (dir: string, rel: string): void => {
    let names: string[];
    try { names = readdirSync(dir).sort(); } catch { return; }
    for (const n of names) {
      if (files.size >= JUDGE_MAX_FILES) { truncated = true; return; }
      const abs = join(dir, n);
      const r = rel ? `${rel}/${n}` : n;
      let st;
      try { st = lstatSync(abs); } catch { continue; }
      if (JUDGE_SKIP.has(n)) { notCompared.push(st.isDirectory() ? `${r}/` : r); continue; }
      if (skipOwn.has(r)) continue;
      if (st.isDirectory()) walk(abs, r);
      else if (st.isSymbolicLink()) {
        let link = '';
        try { link = readlinkSync(abs); } catch { link = ''; }
        files.set(r, { size: Buffer.byteLength(link), sha256: createHash('sha256').update(`symlink\0${link}`).digest('hex'), mtimeMs: st.mtimeMs, link });
      } else if (st.isFile()) {
        let sha: string | null = null;
        if (st.size <= SNAPSHOT_HASH_LIMIT) { try { sha = hashFile(abs); } catch { sha = null; } }
        files.set(r, { size: st.size, sha256: sha, mtimeMs: st.mtimeMs });
      }
    }
  };
  walk(root, '');
  return { files, truncated, notCompared };
}

/** /agent's own view of a judged snapshot: the files with no entry named in SNAPSHOT_SKIP on their path. */
export function regularOf(files: Snapshot): Snapshot {
  const out: Snapshot = new Map();
  for (const [p, v] of files) if (!p.split('/').some((part) => SNAPSHOT_SKIP.has(part))) out.set(p, v);
  return out;
}

/** The check's changes from two judged snapshots of the same run, with its own writes and the entries not looked into. */
export function judgedChanges(before: JudgedSnapshot, after: JudgedSnapshot, own: readonly string[]): JudgedChanges {
  const skipped = [...new Set([...before.notCompared, ...after.notCompared])].sort();
  return {
    scope: JUDGE_SCOPE,
    files: { ...diffSnapshots(before.files, after.files), truncated: before.truncated || after.truncated },
    own: own.map((o) => `${o.replace(/\/+$/, '')}/`),
    not_compared: skipped.slice(0, NOT_COMPARED_MAX),
    ...(skipped.length > NOT_COMPARED_MAX ? { not_compared_more: skipped.length - NOT_COMPARED_MAX } : {}),
  };
}

/** The project-relative folder of `abs` when it is inside the project (both through their real paths), else undefined. */
export function folderInProject(root: string, abs: string): string | undefined {
  const real = (p: string): string => { try { return realpathSync(p); } catch { return p; } };
  const rel = relative(real(root), real(abs));
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.split(sep).join('/') : undefined;
}

/** The agent run's record as the /iterate check judges it: its `files` are the judged snapshot's changes when it has them. */
export const forJudging = (rec: AgentRunRecord): AgentRunRecord => (rec.judged ? { ...rec, files: rec.judged.files } : rec);

/** What a flow's record keeps of the check (`compared`). */
export const comparedOf = (j: JudgedChanges): ComparedScope => ({ scope: j.scope, own: [...j.own], not_compared: [...j.not_compared], ...(j.not_compared_more ? { not_compared_more: j.not_compared_more } : {}) });

/** The entries the check did not look into, in words for the end of a flow; '' when there were none. */
export function notComparedText(c: { not_compared?: unknown; not_compared_more?: unknown } | undefined): string {
  const named = Array.isArray(c?.not_compared) ? c.not_compared.filter((x): x is string => typeof x === 'string') : [];
  if (!named.length) return '';
  const more = typeof c?.not_compared_more === 'number' && c.not_compared_more > 0 ? ` and ${c.not_compared_more} more` : '';
  return `${named.join(', ')}${more} (folders named .git or node_modules are not looked into, for size)`;
}

export const snapshotJson = (s: Snapshot): Record<string, SnapFile> => Object.fromEntries([...s].map(([k, v]) => [k, v]));
export function snapshotFromJson(o: unknown): Snapshot {
  const out: Snapshot = new Map();
  if (!o || typeof o !== 'object') return out;
  for (const [k, v] of Object.entries(o as Record<string, Partial<SnapFile>>)) {
    if (v && typeof v.size === 'number') out.set(k, { size: v.size, sha256: typeof v.sha256 === 'string' ? v.sha256 : null, mtimeMs: typeof v.mtimeMs === 'number' ? v.mtimeMs : 0, ...(typeof v.link === 'string' ? { link: v.link } : {}) });
  }
  return out;
}

// ── progress: what the agent's output says, line by line ─────────────────────────

export interface AgentProgress {
  toolCalls: number;
  /** project-relative paths the agent's own tool calls named as edited or written */
  filesEdited: string[];
  /** the final message its stream reported (a result event, or the last message) */
  finalMessage?: string;
  lastText?: string;
  /** its stream said the run ended in error */
  reportedError?: string;
  /** a total cost the agent itself reported, in USD */
  reportedCostUsd?: number;
  /** tool calls whose result came back as an error */
  toolErrors: number;
  /** tool calls the agent's own permission rules refused (its result event's permission_denials) */
  denied: string[];
  model?: string;
  version?: string;
  structured: number;
  raw: number;
  /** Codex (round R4): how its own stream said its turn ended (turn.completed or turn.failed); absent when it did not say */
  reportedEnd?: 'completed' | 'failed';
  /** Codex (round R4): the tokens its turn.completed reported (counts, not a cost) */
  usage?: { input: number; cached: number; output: number };
}

export const newProgress = (): AgentProgress => ({ toolCalls: 0, filesEdited: [], structured: 0, raw: 0, toolErrors: 0, denied: [] });

const FILE_KEYS = ['file_path', 'filePath', 'absolute_path', 'path', 'notebook_path'];
const EDITS = /edit|write|replace|create|patch|apply/i;
const one = (s: string, n = 120): string => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/** A path an agent named, as the project's relative path; undefined when it is outside the project. */
export function projectRel(root: string, p: string): string | undefined {
  if (!p) return undefined;
  const roots = [root];
  try { roots.push(realpathSync(root)); } catch { /* gone */ }
  for (const r of roots) {
    const rel = isAbsolute(p) ? relative(r, p) : p.replace(/^\.\/+/, '');
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel.split(sep).join('/');
  }
  return undefined;
}

export function noteFile(state: AgentProgress, root: string, p: unknown): string | undefined {
  if (typeof p !== 'string') return undefined;
  const rel = projectRel(root, p);
  if (rel && !state.filesEdited.includes(rel) && state.filesEdited.length < 500) state.filesEdited.push(rel);
  return rel ?? '<outside the project>';
}

/**
 * One line of an agent's output: updates the run's progress and returns the line to show, or undefined for a
 * line that says nothing new. A line that is not JSON is shown as it came (raw text). Given the agent, Codex's
 * output is read by its own parser (round R4: codex-local.ts codexProgressLine, the paid and the local route alike).
 */
export function progressLine(line: string, state: AgentProgress, root: string, agent?: AgentName): string | undefined {
  if (agent === 'codex') return codexProgressLine(line, state, root);
  if (agent === 'openhands') return openHandsProgressLine(line, state, root); // R4 (H52): only lines with its run's token
  const text = line.trim();
  if (!text) return undefined;
  let ev: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an event');
    ev = parsed as Record<string, unknown>;
  } catch {
    state.raw += 1;
    return one(scrubPaths(text, root), 200);
  }
  state.structured += 1;
  const type = String(ev.type ?? '');
  const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? v as Record<string, unknown> : {});
  // Claude Code and Qwen Code (stream-json): system/init, assistant, user, result
  if (type === 'system' && ev.subtype === 'init') {
    if (typeof ev.model === 'string') state.model = ev.model;
    const v = ev.qwen_code_version ?? ev.claude_code_version ?? ev.version;
    if (typeof v === 'string') state.version = v;
    return `started${state.model ? `  model ${state.model}` : ''}`;
  }
  if (type === 'assistant') {
    const shown: string[] = [];
    const content = obj(ev.message).content;
    for (const block of Array.isArray(content) ? content : []) {
      const b = obj(block);
      if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) { state.lastText = b.text; shown.push(`says  ${one(scrubPaths(b.text, root))}`); }
      if (b.type === 'tool_use') {
        state.toolCalls += 1;
        const name = String(b.name ?? 'tool');
        const input = obj(b.input);
        const key = FILE_KEYS.find((k) => typeof input[k] === 'string');
        const file = key && EDITS.test(name) ? noteFile(state, root, input[key]) : key ? (projectRel(root, String(input[key])) ?? '<outside the project>') : undefined;
        shown.push(`tool  ${name}${file ? `  ${file}` : typeof input.command === 'string' ? `  ${one(scrubPaths(input.command, root), 80)}` : ''}`);
      }
    }
    return shown.length ? shown.join('\n') : undefined;
  }
  if (type === 'user') {
    const content = obj(ev.message).content;
    const failed = (Array.isArray(content) ? content : []).filter((b) => obj(b).type === 'tool_result' && obj(b).is_error === true);
    state.toolErrors += failed.length;
    const first = failed.length ? obj(failed[0]).content : undefined;
    return failed.length ? `tool failed${failed.length > 1 ? ` (${failed.length})` : ''}${typeof first === 'string' ? `: ${one(scrubPaths(first, root), 120)}` : ''}` : undefined;
  }
  if (type === 'result') {
    if (typeof ev.result === 'string') state.finalMessage = ev.result;
    const err = ev.is_error === true || (typeof ev.subtype === 'string' && ev.subtype !== 'success');
    if (err) state.reportedError = typeof ev.subtype === 'string' ? ev.subtype : 'error';
    if (typeof ev.total_cost_usd === 'number' && Number.isFinite(ev.total_cost_usd)) state.reportedCostUsd = ev.total_cost_usd;
    // qwen 0.25.0 (observed): a refused tool call is listed in the result's permission_denials, and the run still says success
    if (Array.isArray(ev.permission_denials)) state.denied = ev.permission_denials.map((d) => String(obj(d).tool_name ?? 'tool')).slice(0, 50);
    const denied = state.denied.length ? ` · ${state.denied.length} tool call${state.denied.length === 1 ? '' : 's'} denied (${[...new Set(state.denied)].join(', ')})` : '';
    return `done  ${err ? `error: ${state.reportedError}` : 'success'}${typeof ev.num_turns === 'number' ? ` · ${ev.num_turns} turns` : ''}${denied}`;
  }
  // Codex (exec --json): item.started / item.completed, turn.completed, turn.failed, error
  if (type === 'item.completed' || type === 'item.started') {
    const item = obj(ev.item);
    if (item.type === 'agent_message' && typeof item.text === 'string') { state.lastText = item.text; state.finalMessage = item.text; return `says  ${one(scrubPaths(item.text, root))}`; }
    if (type === 'item.started') return undefined;
    if (item.type === 'command_execution') { state.toolCalls += 1; return `command  ${one(scrubPaths(String(item.command ?? ''), root), 80)}${typeof item.exit_code === 'number' ? `  exit ${item.exit_code}` : ''}`; }
    if (item.type === 'file_change') {
      state.toolCalls += 1;
      const names = (Array.isArray(item.changes) ? item.changes : []).map((c) => noteFile(state, root, obj(c).path)).filter(Boolean);
      return `files  ${names.join(', ')}`;
    }
    return undefined;
  }
  if (type === 'turn.failed' || type === 'error') {
    const msg = obj(ev.error).message ?? ev.message;
    state.reportedError = typeof msg === 'string' ? one(scrubPaths(msg, root), 160) : type;
    return `error  ${state.reportedError}`;
  }
  // OpenCode (run --format json): text, tool_use, step_finish (with its cost), error
  if (type === 'text') {
    const t = obj(ev.part).text;
    if (typeof t === 'string' && t.trim()) { state.lastText = t; return `says  ${one(scrubPaths(t, root))}`; }
    return undefined;
  }
  if (type === 'tool_use') {
    const part = obj(ev.part);
    state.toolCalls += 1;
    const tool = String(part.tool ?? 'tool');
    const input = obj(obj(part.state).input);
    const key = FILE_KEYS.find((k) => typeof input[k] === 'string');
    const file = key ? (EDITS.test(tool) ? noteFile(state, root, input[key]) : projectRel(root, String(input[key]))) : undefined;
    return `tool  ${tool}${file ? `  ${file}` : ''}`;
  }
  if (type === 'step_finish') {
    const cost = obj(ev.part).cost;
    if (typeof cost === 'number' && Number.isFinite(cost)) state.reportedCostUsd = (state.reportedCostUsd ?? 0) + cost;
    return undefined;
  }
  return undefined;
}

// ── the result ───────────────────────────────────────────────────────────────

/** `unknown`: it exited 0 but its output held nothing Timmy could read as the agent's report (the review of ee70b9e). */
export type AgentOutcome = 'completed' | 'failed' | 'cancelled' | 'timed out' | 'unknown';

export interface AgentRunRecord {
  agent_run: 1;
  run: string;
  agent: AgentName;
  agent_version: string | null;
  model: string | null;
  endpoint: 'local' | 'remote';
  where: string;
  task: string;
  job: string;
  /** Round R4 (H51): the operation (one request) that started the run (src/ops/context.ts); absent before, or outside one */
  operation?: string;
  started_at: string;
  ended_at?: string;
  exit_code?: number | null;
  signal?: string | null;
  outcome?: AgentOutcome;
  why?: string;
  files?: ChangeSet & { truncated: boolean };
  git_diff_stat?: { before: string; after: string } | null;
  final_message?: { file: string; chars: number; truncated: boolean } | null;
  progress?: { tool_calls: number; files_edited: string[]; tool_errors: number; denied: string[]; structured_lines: number; raw_lines: number };
  /** 0 with basis "local endpoint"; a paid agent's own reported total; null when no cost was reported (unknown, never 0) */
  cost_usd?: number | null;
  cost_basis?: string;
  transcript?: string;
  receipt?: string;
  /** R4 (H52): an OpenHands run's container, its copy of the project and what was written back from it (openhands.ts) */
  openhands?: OpenHandsRecord;
  /**
   * Round R4 (the review's R4-2): for an /iterate run, what its check saw: the changes over the whole project (.timmy and
   * dist included) with Timmy's own writes during the run left out, and the entries not looked into. `files` above stays
   * /agent's own view (no .timmy, dist, .git or node_modules), read from that same walk, so Timmy's own writes (a jobs
   * folder in the project, say) are left out of it too.
   */
  judged?: JudgedChanges;
  /** R4 (H50): the checked lessons /agent's task was given (src/memory/retrieve.ts); [] when none applied */
  lessons?: Array<{ id: string; sha256: string; status: string }>;
  /** R4 (H59): run.json's own state (result.json, what was sealed, has none) */
  state?: RunRecordState;
  /** R4 (H59): what a later session's recovery recorded when the REPL running it ended first (run-end.ts); never a result */
  recovered?: AgentRunRecovered;
}

/**
 * R4 (H59): run.json's state: "submitted" at its start, "ended" once its result is written (src/repl/workspace.ts), and
 * "interrupted" when a later session's recovery recorded that the REPL running it ended first (src/code-agents/run-end.ts).
 */
export type RunRecordState = 'submitted' | 'ended' | 'interrupted';

/** R4 (H59): an interrupted run's end as recovery recorded it in run.json: how it ended, its job, and that no result was written. */
export interface AgentRunRecovered {
  /** when recovery wrote this */
  at: string;
  by: 'recovery';
  /** what became of its process: stopped by recovery, found gone (when it ended is not recorded), ended as its job's record
   *  already said (an earlier recovery recorded it), or its OpenHands container stopped by recovery */
  process: 'stopped by recovery' | 'gone' | 'ended before' | 'container stopped by recovery';
  /** the job that ran it, as its own record says now */
  job: { id: string; state: string; error?: string };
  /** the process group recovery stopped, and with what */
  stopped?: { process_group: number; processes: number; signals: string[]; cleanup: 'complete' | 'unresolved' };
  /** the OpenHands container recovery stopped, or (R4, H62) found already gone with its docker client (process 'gone') */
  container?: string;
  /** the flow whose agent step it was */
  flow?: string;
  /** it never reached its end in its REPL, so it was never judged: no outcome, files, final message or cost of its own */
  result: 'not written';
}

/** R4 (H59): the run's own record, beside its result. */
export const RUN_RECORD = 'run.json';

/**
 * R4 (H59): the one writer of a run's run.json (at its start and its end in src/repl/workspace.ts, and when recovery ends a
 * run its REPL left, src/code-agents/run-end.ts): the record written whole through writeJson.
 */
export function writeRunRecord(dir: string, value: AgentRunRecord & { state: RunRecordState }): { sha256: string; bytes: number } {
  return writeJson(join(dir, RUN_RECORD), value);
}

export const runDir = (root: string, run: string): string => join(root, AGENTS_DIR, run);

/** How the run ended, from the job's end and what the agent's stream reported; `stopBy`, the words its stop gave. */
export function judgeAgentRun(job: { state: string; exitCode?: number | null; signal?: string | null; error?: string }, progress: AgentProgress, agent: AgentName, stopBy?: string): { outcome: AgentOutcome; why: string } {
  if (agent === 'openhands') return judgeOpenHands(job, progress, stopBy); // R4 (H52): its result line, read with its token
  if (job.state === 'cancelled') return { outcome: 'cancelled', why: cancelledWhy(stopBy) };
  if (job.error === 'timed out') return { outcome: 'timed out', why: 'Timmy\'s time limit ended it (its wall time and any grace period)' };
  if (agent === 'qwen' && job.exitCode === QWEN_BUDGET_EXIT) return { outcome: 'timed out', why: `its own wall-time budget ended it (exit ${QWEN_BUDGET_EXIT})` };
  if (job.state !== 'completed') return { outcome: 'failed', why: job.error ?? (progress.reportedError ? `it reported ${progress.reportedError}` : `it exited ${job.exitCode ?? job.signal ?? '?'}`) };
  if (progress.reportedError) return { outcome: 'failed', why: `it exited 0 but reported ${progress.reportedError}` };
  // No structured event and no final message: an exit status is not a report, so success is not claimed and the
  // run never marks the agent exercised (only a completed outcome does).
  if (progress.structured === 0 && !progress.finalMessage) return { outcome: 'unknown', why: 'it exited 0 but reported nothing Timmy could read (no structured events, no final message): whether it did the task is not known; the files it changed are listed' };
  // Round R4 (H25): Codex reports success with its own turn.completed event (codex-local.ts; the names are assumed). A
  // stream that never says so is not a report of success, whatever else it printed.
  if (agent === 'codex' && progress.reportedEnd !== 'completed') return { outcome: 'unknown', why: 'it exited 0, but its event stream never said its turn completed (no turn.completed): whether it did the task is not known; the files it changed are listed' };
  const denied = progress.denied.length ? `; ${progress.denied.length} of its tool calls ${progress.denied.length === 1 ? 'was' : 'were'} denied (${[...new Set(progress.denied)].join(', ')})` : '';
  return { outcome: 'completed', why: `it exited 0 and reported success${denied}` };
}

/** The final message, bounded: the text kept and whether it was cut. */
export function boundMessage(text: string, max = FINAL_MESSAGE_MAX): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: `${text.slice(0, max)}\n\n[truncated: the agent's final message had ${text.length} characters; the first ${max} are kept here, the rest is in transcript.log]`, truncated: true };
}

export function writeJson(path: string, value: unknown): { sha256: string; bytes: number } {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(path, body);
  return { sha256: createHash('sha256').update(body).digest('hex'), bytes: Buffer.byteLength(body) };
}

export function appendProgress(dir: string, lines: string): void {
  try { appendFileSync(join(dir, 'progress.log'), `${lines}\n`); } catch { /* a full disk loses progress text, not the run */ }
}

export function readProgressTail(root: string, run: string, n = 12): string[] {
  try {
    const lines = readFileSync(join(runDir(root, run), 'progress.log'), 'utf8').split('\n').filter(Boolean);
    return lines.slice(-n);
  } catch { return []; }
}

/** The project's agent runs, newest first, as their records say (a run without a result was not finished here). */
export function listAgentRuns(root: string): AgentRunRecord[] {
  const dir = join(root, AGENTS_DIR);
  if (!existsSync(dir)) return [];
  const out: AgentRunRecord[] = [];
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return []; }
  const read = (path: string): AgentRunRecord | undefined => {
    try { return JSON.parse(readFileSync(path, 'utf8')) as AgentRunRecord; } catch { return undefined; }
  };
  for (const n of names) {
    if (!/^a[0-9a-f]{8}$/.test(n)) continue;
    // result.json is what was sealed; run.json adds the receipt it got (written after sealing)
    const result = read(join(dir, n, 'result.json'));
    const runRec = read(join(dir, n, 'run.json'));
    const rec = result && result.run === n ? { ...result, ...(runRec?.receipt ? { receipt: runRec.receipt } : {}) } : runRec && runRec.run === n ? runRec : undefined;
    if (rec) out.push(rec);
  }
  return out.sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
}

/** Whether the folder is in a git work tree (a quick check, nothing written). */
export const isGitDir = (root: string): boolean => {
  let d = root;
  for (let i = 0; i < 128; i++) {
    if (existsSync(join(d, '.git'))) return true;
    const up = dirname(d);
    if (up === d) return false;
    d = up;
  }
  return false;
};

export const ensureDir = (path: string): void => { mkdirSync(path, { recursive: true }); };

// ── /tools: exercised by a completed run of that agent, never another's ───────────

/**
 * Agent name → the newest time a sealed receipt says a run of that agent completed (kind agent, status ok,
 * outcome completed). A submitted, failed, cancelled or timed-out run never counts, and a run counts only for
 * its own agent. Round R4 (H25): only for its own route, too: a completed Codex run on a local endpoint (only the
 * local route plans one) counts for `codex-local`, never for the paid `codex` row, and a paid run never for it.
 */
export function agentExercisedIndex(chain: Array<Record<string, unknown>>): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of chain) {
    const a = r.agent as { name?: unknown; outcome?: unknown; endpoint?: unknown } | undefined;
    if (r.kind !== 'agent' || r.status !== 'ok' || !a || typeof a.name !== 'string' || a.outcome !== 'completed' || typeof r.ts !== 'string') continue;
    const job = r.job as { state?: unknown } | undefined;
    if (job && job.state !== 'completed') continue;
    const key = a.name === 'codex' && a.endpoint === 'local' ? CODEX_LOCAL_ROUTE : a.name;
    const prev = out.get(key);
    if (!prev || prev < r.ts) out.set(key, r.ts);
  }
  return out;
}

/** The time a row keyed agent:<name> was last exercised, or undefined. */
export function agentExercisedAt(key: string, index: Map<string, string> | undefined): string | undefined {
  if (!key.startsWith('agent:')) return undefined;
  return index?.get(key.slice('agent:'.length));
}
