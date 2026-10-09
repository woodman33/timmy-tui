/**
 * Code agents from the REPL (round R3, /agent): Qwen Code, Claude Code, Codex and OpenCode run headless in
 * the active project as Timmy jobs, each run with its own operation ID (the run id) kept in its job label, its
 * run folder (.timmy/agents/<run>/), its result and its receipt.
 *
 * Every command line below is built from the CLIs' own --help texts as captured on the operator's Mac
 * (qwen 0.25.0, Claude Code 2.1.251, codex-cli 0.140.0, opencode 1.18.31); each flag cites the line it
 * relies on. Nothing here decides that a run is free except the endpoint rule (endpointClass): Qwen Code on a
 * loopback OpenAI-compatible endpoint with a model whose tag does not end in ":cloud". Everything else may
 * cost money and runs only when the operator's line says --paid. A cloud-backed model tag remains cloud.
 */
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

export type AgentName = 'qwen' | 'claude' | 'codex' | 'opencode';
export const AGENT_NAMES: readonly AgentName[] = ['qwen', 'claude', 'codex', 'opencode'];

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
  stream: 'claude-stream' | 'codex-json' | 'opencode-json';
}

export const AGENTS: Readonly<Record<AgentName, AgentInfo>> = {
  qwen: { title: 'Qwen Code', bin: 'qwen', binEnv: 'TIMMY_AGENT_QWEN_BIN', harnessId: 'qwen-code', modelEnv: 'TIMMY_AGENT_MODEL', stream: 'claude-stream' },
  claude: { title: 'Claude Code', bin: 'claude', binEnv: 'TIMMY_AGENT_CLAUDE_BIN', harnessId: 'claude-code', modelEnv: 'TIMMY_AGENT_CLAUDE_MODEL', stream: 'claude-stream' },
  codex: { title: 'Codex', bin: 'codex', binEnv: 'TIMMY_AGENT_CODEX_BIN', harnessId: 'codex', modelEnv: 'TIMMY_AGENT_CODEX_MODEL', stream: 'codex-json' },
  opencode: { title: 'OpenCode', bin: 'opencode', binEnv: 'TIMMY_AGENT_OPENCODE_BIN', harnessId: 'opencode', modelEnv: 'TIMMY_AGENT_OPENCODE_MODEL', stream: 'opencode-json' },
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
  return onPath(info.bin);
}

// ── the endpoint rule ──────────────────────────────────────────────────────────

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export interface EndpointClass {
  local: boolean;
  /** host[:port] only: never the path, a user or a key */
  where: string;
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
  if (!LOOPBACK.has(url.hostname.toLowerCase())) return { local: false, where, why: `${where} is not this machine` };
  if (model && /:cloud$/i.test(model.trim())) return { local: false, where, why: `${model.trim()} is a cloud model (its tag ends in :cloud): the endpoint on this machine sends it to a cloud` };
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
  /** Codex writes its last message here (project-relative), from its -o flag */
  lastMessageFile?: string;
  /** added to the agent's environment: HOME from TIMMY_AGENT_HOME, so its settings and records stay out of the user's own */
  env?: Record<string, string>;
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

export function planAgent(name: AgentName, task: string, o: { env: Env; paid: boolean; run: string; bin: string }): PlanResult {
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
  if (name === 'qwen') {
    if (!model) {
      return { ok: false, refused: 'setup', error: 'Set TIMMY_AGENT_MODEL to the model Qwen Code should use (for a local Ollama, a name from `ollama list`), then /agent qwen again. Nothing was started.' };
    }
    const baseUrl = set(env.TIMMY_AGENT_BASE_URL) ? env.TIMMY_AGENT_BASE_URL.trim() : DEFAULT_BASE_URL;
    const ep = endpointClass(baseUrl, model);
    const key = set(env.TIMMY_AGENT_API_KEY) ? env.TIMMY_AGENT_API_KEY.trim() : ep.local ? LOCAL_KEY_PLACEHOLDER : null;
    if (!ep.local && !o.paid) {
      return { ok: false, refused: 'paid', error: `Remote, so it may cost money: ${ep.why}. It would send the task, and the project files Qwen Code reads, to ${ep.where}. Nothing was started. To run it anyway: /agent qwen --paid <task>` };
    }
    if (!key) return { ok: false, refused: 'setup', error: `Set TIMMY_AGENT_API_KEY for ${ep.where} (a remote endpoint), then /agent qwen --paid again. Nothing was started.` };
    // Every flag below is from qwen-help.txt (qwen 0.25.0):
    const args = [
      '--bare',                              // "--bare  Minimal mode: skip implicit startup auto-discovery and only honor explicitly provided CLI inputs."
      '--auth-type', 'openai',               // "--auth-type  Authentication type  [choices: "openai", ...]"
      '--openai-base-url', baseUrl,          // "--openai-base-url  OpenAI base URL (for custom endpoints)"
      '--openai-api-key', key,               // "--openai-api-key  OpenAI API key to use for authentication"
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
        agent: name, command: o.bin, args, model, endpoint: ep.local ? 'local' : 'remote', where: ep.where, wallTime, timeoutMs, ...home,
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
    // Every flag below is from codex-exec-help.txt (codex-cli 0.140.0):
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
    return { ok: true, plan: { ...base, args, where: 'your OpenAI account', lastMessageFile: last } };
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

/** `/agent <name> [--paid] <task…>`: the agent, the task and whether the line says --paid. */
export function parseAgentLine(line: string): { name?: AgentName; word?: string; paid: boolean; task: string } {
  const words = line.trim().split(/\s+/).filter(Boolean);
  const word = words[0];
  const name = AGENT_NAMES.find((n) => n === word?.toLowerCase());
  const rest = line.trim().slice(word ? word.length : 0);
  const paid = /(?:^|\s)--paid(?=\s|$)/.test(rest);
  const task = rest.replace(/(?:^|\s)--paid(?=\s|$)/g, ' ').trim();
  return { ...(name ? { name } : {}), ...(word ? { word } : {}), paid, task };
}

export const newRunId = (): string => `a${randomBytes(4).toString('hex')}`;

// ── the label: no absolute path, the first words of the task ─────────────────────

/** Free text with the project's folder as "." and the home folder as "~". */
export function scrubPaths(text: string, root: string): string {
  let out = text;
  const roots = [root];
  try { roots.push(realpathSync(root)); } catch { /* gone */ }
  for (const r of [...new Set(roots)].sort((a, b) => b.length - a.length)) if (r.length > 1) out = out.split(r).join('.');
  const home = homedir();
  if (home.length > 1) out = out.split(home).join('~');
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

export interface SnapFile { size: number; sha256: string | null; mtimeMs: number }
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
      else if (st.isFile()) {
        let sha: string | null = null;
        if (st.size <= SNAPSHOT_HASH_LIMIT) { try { sha = hashFile(abs); } catch { sha = null; } }
        files.set(r, { size: st.size, sha256: sha, mtimeMs: st.mtimeMs });
      }
    }
  };
  walk(root, '');
  return { files, truncated };
}

export interface FileChange { path: string; size: number; sha256: string | null; previous_sha256?: string | null; previous_size?: number }
export interface ChangeSet { added: FileChange[]; changed: FileChange[]; deleted: FileChange[] }

export function diffSnapshots(before: Snapshot, after: Snapshot): ChangeSet {
  const out: ChangeSet = { added: [], changed: [], deleted: [] };
  for (const [path, a] of after) {
    const b = before.get(path);
    if (!b) { out.added.push({ path, size: a.size, sha256: a.sha256 }); continue; }
    const differs = a.sha256 && b.sha256 ? a.sha256 !== b.sha256 : a.size !== b.size || a.mtimeMs !== b.mtimeMs;
    if (differs) out.changed.push({ path, size: a.size, sha256: a.sha256, previous_sha256: b.sha256, previous_size: b.size });
  }
  for (const [path, b] of before) if (!after.has(path)) out.deleted.push({ path, size: 0, sha256: null, previous_sha256: b.sha256, previous_size: b.size });
  return out;
}

export const snapshotJson = (s: Snapshot): Record<string, SnapFile> => Object.fromEntries([...s].map(([k, v]) => [k, v]));
export function snapshotFromJson(o: unknown): Snapshot {
  const out: Snapshot = new Map();
  if (!o || typeof o !== 'object') return out;
  for (const [k, v] of Object.entries(o as Record<string, Partial<SnapFile>>)) {
    if (v && typeof v.size === 'number') out.set(k, { size: v.size, sha256: typeof v.sha256 === 'string' ? v.sha256 : null, mtimeMs: typeof v.mtimeMs === 'number' ? v.mtimeMs : 0 });
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

function noteFile(state: AgentProgress, root: string, p: unknown): string | undefined {
  if (typeof p !== 'string') return undefined;
  const rel = projectRel(root, p);
  if (rel && !state.filesEdited.includes(rel) && state.filesEdited.length < 500) state.filesEdited.push(rel);
  return rel ?? '<outside the project>';
}

/**
 * One line of an agent's output: updates the run's progress and returns the line to show, or undefined for a
 * line that says nothing new. A line that is not JSON is shown as it came (raw text).
 */
export function progressLine(line: string, state: AgentProgress, root: string): string | undefined {
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

export type AgentOutcome = 'completed' | 'failed' | 'cancelled' | 'timed out';

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
}

export const runDir = (root: string, run: string): string => join(root, AGENTS_DIR, run);

/** How the run ended, from the job's end and what the agent's stream reported. */
export function judgeAgentRun(job: { state: string; exitCode?: number | null; signal?: string | null; error?: string }, progress: AgentProgress, agent: AgentName): { outcome: AgentOutcome; why: string } {
  if (job.state === 'cancelled') return { outcome: 'cancelled', why: 'stopped with /stop (or the REPL ended) before it finished' };
  if (job.error === 'timed out') return { outcome: 'timed out', why: 'Timmy\'s time limit ended it (its wall time and a grace period)' };
  if (agent === 'qwen' && job.exitCode === QWEN_BUDGET_EXIT) return { outcome: 'timed out', why: `its own wall-time budget ended it (exit ${QWEN_BUDGET_EXIT})` };
  if (job.state !== 'completed') return { outcome: 'failed', why: job.error ?? (progress.reportedError ? `it reported ${progress.reportedError}` : `it exited ${job.exitCode ?? job.signal ?? '?'}`) };
  if (progress.reportedError) return { outcome: 'failed', why: `it exited 0 but reported ${progress.reportedError}` };
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
 * its own agent.
 */
export function agentExercisedIndex(chain: Array<Record<string, unknown>>): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of chain) {
    const a = r.agent as { name?: unknown; outcome?: unknown } | undefined;
    if (r.kind !== 'agent' || r.status !== 'ok' || !a || typeof a.name !== 'string' || a.outcome !== 'completed' || typeof r.ts !== 'string') continue;
    const job = r.job as { state?: unknown } | undefined;
    if (job && job.state !== 'completed') continue;
    const prev = out.get(a.name);
    if (!prev || prev < r.ts) out.set(a.name, r.ts);
  }
  return out;
}

/** The time a row keyed agent:<name> was last exercised, or undefined. */
export function agentExercisedAt(key: string, index: Map<string, string> | undefined): string | undefined {
  if (!key.startsWith('agent:')) return undefined;
  return index?.get(key.slice('agent:'.length));
}
