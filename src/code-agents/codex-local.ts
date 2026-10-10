/**
 * Round R4 (helper H25): Codex with a local model, a second free code-agent route beside Qwen Code.
 *
 *   /agent codex --local <task>                     a job in the project, as /agent runs every agent
 *   /iterate tray "<instruction>" --agent codex     the same route, through /agent's own start
 *
 * It plans `codex exec --oss --local-provider ollama -m <model> --json --skip-git-repo-check -s workspace-write
 * -C <project> …`: Codex driving the model a local Ollama serves. It is free only under Qwen Code's rule
 * (endpointClass): the endpoint (TIMMY_AGENT_BASE_URL, else 127.0.0.1:11434) is this machine and the model's tag
 * does not end in cloud. Anything else is refused, and this route has no --paid. Without --local, Codex is the
 * paid route on the user's own account, exactly as before (index.ts).
 *
 * Every flag is from tests/fixtures/agent-help/codex-exec-help.txt, the `codex exec --help` of codex-cli 0.140.0
 * captured on the operator's Mac in round R3. ASSUMED, from codex-rs's source as known, and not checked against
 * codex-cli 0.140.0 (no real run of this route is recorded):
 * - the names and shapes of its --json events (codexProgressLine below);
 * - that its built-in ollama provider takes its address from CODEX_OSS_BASE_URL: set in the child's environment
 *   to the endpoint the rule judged, so a value inherited from Timmy's own environment cannot send it elsewhere;
 * - that --oss downloads a model the local Ollama does not list (codex-rs ensure_oss_ready): so a run starts only
 *   when that endpoint already lists the model by its exact name (codexLocalPreflight); no download is started.
 */
import { join } from 'node:path';
import {
  AGENTS_DIR, DEFAULT_BASE_URL, endpointClass, noteFile, projectRel, scrubPaths,
  type AgentPlan, type AgentProgress, type PlanResult,
} from './index.js';

type Env = Record<string, string | undefined>;
const set = (v: string | undefined): v is string => typeof v === 'string' && v.trim() !== '';

/** The route's key: its /tools row (`agent:codex-local`) and the receipts that mark it exercised (index.ts). */
export const CODEX_LOCAL_ROUTE = 'codex-local';
/** The local provider named on the command line: codex-cli 0.140.0 offers lmstudio or ollama. */
export const CODEX_LOCAL_PROVIDER = 'ollama';
/** Blank in the child's environment: no OpenAI, OpenRouter or Timmy key is the local model's to use. */
export const CODEX_LOCAL_BLANKED = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENROUTER_API_KEY', 'TIMMY_AGENT_API_KEY'] as const;

export interface CodexLocalInput {
  task: string;
  /** the task as the last argument (taskArg: a task that begins with "-" is given as "Task: …") */
  prompt: string;
  env: Env;
  run: string;
  bin: string;
  /** the project folder: Codex's working root (-C) */
  root: string;
  wallTime: string;
  timeoutMs: number;
}

/** The plan for `/agent codex --local <task>`, or why nothing may start. Pure: nothing is read or written. */
export function planCodexLocal(o: CodexLocalInput): PlanResult {
  const env = o.env;
  const model = set(env.TIMMY_AGENT_MODEL) ? env.TIMMY_AGENT_MODEL.trim() : null;
  if (!model) {
    return { ok: false, refused: 'setup', error: 'Set TIMMY_AGENT_MODEL to the model Codex should use on this machine\'s Ollama (a name from `ollama list`), then /agent codex --local again. Nothing was started.' };
  }
  const baseUrl = set(env.TIMMY_AGENT_BASE_URL) ? env.TIMMY_AGENT_BASE_URL.trim() : DEFAULT_BASE_URL;
  const ep = endpointClass(baseUrl, model);
  if (ep.credentials) return { ok: false, refused: 'setup', error: 'TIMMY_AGENT_BASE_URL carries a user name or password; Codex\'s local route takes none. Nothing was started.' };
  if (!ep.local) {
    return { ok: false, refused: 'paid', error: `Remote, so it may cost money: ${ep.why}. Codex's local route runs only on this machine's Ollama, with a model that is not a cloud model. Nothing was started.` };
  }
  const last = `${AGENTS_DIR}/${o.run}/codex-last-message.txt`;
  // Every flag below is from codex-exec-help.txt (codex-cli 0.140.0). Never --dangerously-bypass-approvals-and-sandbox.
  const args = [
    'exec',                                  // "codex exec  Run Codex non-interactively"
    '--oss',                                 // "--oss  Use open-source provider"
    '--local-provider', CODEX_LOCAL_PROVIDER, // "--local-provider <OSS_PROVIDER>  Specify which local provider to use (lmstudio or ollama)"
    '-m', model,                             // "-m, --model <MODEL>  Model the agent should use"
    '--json',                                // "--json  Print events to stdout as JSONL"
    '--skip-git-repo-check',                 // "--skip-git-repo-check  Allow running Codex outside a Git repository"
    '-s', 'workspace-write',                 // "-s, --sandbox <SANDBOX_MODE> ... [possible values: read-only, workspace-write, danger-full-access]"
    '-C', o.root,                            // "-C, --cd <DIR>  Tell the agent to use the specified directory as its working root"
    // Beyond the line the round R4 order named, each from the same help text: the user's config.toml (its MCP
    // servers and profiles, which could reach paid services) is not loaded, no session is kept on disk, and the
    // last message is written where the paid route writes it.
    '--ignore-user-config',                  // "--ignore-user-config  Do not load `$CODEX_HOME/config.toml`; auth still uses `CODEX_HOME`"
    '--ephemeral',                           // "--ephemeral  Run without persisting session files to disk"
    '-o', last,                              // "-o, --output-last-message <FILE>  Specifies file where the last message from the agent should be written"
    o.prompt,                                // "[PROMPT]  Initial instructions for the agent"
  ];
  // TIMMY_AGENT_HOME: Codex runs with that HOME and its own CODEX_HOME inside it, so the user's own codex settings
  // and sign-in are not used (an inherited CODEX_HOME would otherwise lead back to them). Codex needs that folder
  // to exist: the run makes it (makeDirs) just before it starts.
  const home = set(env.TIMMY_AGENT_HOME) ? env.TIMMY_AGENT_HOME.trim() : null;
  const codexHome = home ? join(home, '.codex') : null;
  const childEnv: Record<string, string> = {
    ...(home && codexHome ? { HOME: home, CODEX_HOME: codexHome } : {}),
    CODEX_OSS_BASE_URL: baseUrl,
    CODEX_OSS_PORT: '',
    ...Object.fromEntries(CODEX_LOCAL_BLANKED.map((k) => [k, ''])),
  };
  const plan: AgentPlan = {
    agent: 'codex', command: o.bin, args, model, endpoint: 'local', where: ep.where, wallTime: o.wallTime, timeoutMs: o.timeoutMs,
    charge: 'local endpoint, no charge', costBasis: 'local endpoint', lastMessageFile: last, env: childEnv,
    // "If stdin is piped and a prompt is also provided, stdin is appended" (its help): the job's stdin is ended at once.
    stdin: 'closed',
    oss: { provider: CODEX_LOCAL_PROVIDER, baseUrl, model },
    ...(codexHome ? { makeDirs: [codexHome] } : {}),
    note: home
      ? 'codex exec --oss on this machine\'s Ollama; its own HOME and CODEX_HOME (TIMMY_AGENT_HOME): your codex settings and sign-in are not used'
      : 'codex exec --oss on this machine\'s Ollama; your codex folder (~/.codex or CODEX_HOME) is used, not its config.toml; TIMMY_AGENT_HOME gives it its own',
  };
  return { ok: true, plan };
}

// ── before the run: the model must already be there ─────────────────────────────

/** Ollama's own API root for its OpenAI-compatible address: http://127.0.0.1:11434/v1 → http://127.0.0.1:11434. */
export function ollamaRoot(baseUrl: string): string {
  const u = new URL(baseUrl);
  const path = u.pathname.replace(/\/+$/, '').replace(/\/v1$/i, '');
  return `${u.protocol}//${u.host}${path}`;
}

export type Preflight = { ok: true; models: string[] } | { ok: false; error: string };

/**
 * Asks the local Ollama for its models (GET /api/tags) and admits the run only when it lists the model by the exact
 * name Codex will ask for: codex --oss downloads a model it does not find (assumed, see above), and Timmy starts no
 * download. Nothing is written; the task is not sent.
 */
export async function codexLocalPreflight(oss: NonNullable<AgentPlan['oss']>, o: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<Preflight> {
  let where = 'its address';
  let url: string;
  try { where = new URL(oss.baseUrl).host; url = `${ollamaRoot(oss.baseUrl)}/api/tags`; } catch {
    return { ok: false, error: `TIMMY_AGENT_BASE_URL is not an address Codex's local route can use. Nothing was started.` };
  }
  let res: Response;
  try {
    res = await (o.fetch ?? fetch)(url, { signal: AbortSignal.timeout(o.timeoutMs ?? 3000), redirect: 'manual' });
  } catch {
    return { ok: false, error: `The Ollama at ${where} did not answer: start it (ollama serve, or brew services start ollama), then try again. Nothing was started.` };
  }
  let names: string[] | undefined;
  if (res.ok) {
    try {
      const body = await res.json() as { models?: unknown };
      if (Array.isArray(body?.models)) names = body.models.map((m) => (m && typeof m === 'object' ? (m as { name?: unknown }).name : undefined)).filter((n): n is string => typeof n === 'string');
    } catch { names = undefined; }
  } else {
    try { await res.body?.cancel(); } catch { /* nothing to read */ }
  }
  if (!names) return { ok: false, error: `${where} did not answer as an Ollama (GET /api/tags: HTTP ${res.status}); Codex's local route needs one (--local-provider ollama). Nothing was started.` };
  if (!names.includes(oss.model)) {
    const base = oss.model.split(':')[0];
    const near = names.filter((n) => n.split(':')[0] === base).slice(0, 4);
    return {
      ok: false,
      error: `The Ollama at ${where} does not list ${oss.model}${near.length ? ` (it lists ${near.join(', ')})` : ''}. codex --oss downloads a model it does not find, so Timmy starts it only with a model already there: name one exactly as \`ollama list\` does, or pull it yourself first (ollama pull ${oss.model}). Nothing was started.`,
    };
  }
  return { ok: true, models: names };
}

// ── its events ──────────────────────────────────────────────────────────────────

/**
 * The `codex exec --json` events this parser reads. ASSUMED names (codex-rs exec_events.rs as known; not confirmed
 * for codex-cli 0.140.0): thread.started; turn.started; turn.completed {usage}; turn.failed {error.message};
 * item.started, item.updated and item.completed {item}, where item.type is agent_message, reasoning,
 * command_execution {command, exit_code, status}, file_change {changes[{path, kind}], status}, mcp_tool_call
 * {server, tool, status}, web_search {query}, todo_list {items[{text, completed}]} or error {message} (the earliest
 * format named it item_type, and an agent message assistant_message: both read); and error {message}.
 */
export const CODEX_EVENTS = ['thread.started', 'turn.started', 'turn.completed', 'turn.failed', 'item.started', 'item.updated', 'item.completed', 'error'] as const;
const KNOWN: ReadonlySet<string> = new Set(CODEX_EVENTS);
/** The most event or item types named as unread in one run's progress. */
const NAMED_MAX = 20;

interface Seen { events: Set<string>; items: Set<string>; tentative: boolean }
const seen = new WeakMap<AgentProgress, Seen>();
const seenOf = (state: AgentProgress): Seen => {
  let s = seen.get(state);
  if (!s) { s = { events: new Set(), items: new Set(), tentative: false }; seen.set(state, s); }
  return s;
};
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const short = (s: string, n = 120): string => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const count = (n: number): string => n.toLocaleString('en-US');
export const tokenText = (u: NonNullable<AgentProgress['usage']>): string => `${count(u.input)} tokens in${u.cached ? ` (${count(u.cached)} cached)` : ''}, ${count(u.output)} out`;

/**
 * One line of Codex's output: updates the run's progress and returns the line to show, or undefined. A line that is
 * not JSON is shown as it came (raw); a JSON line whose type is not one of CODEX_EVENTS is counted raw too (never as
 * Codex reporting anything) and its type is named once. Success is Codex's own turn.completed: an `error` event
 * (Codex also sends one for a stream error it retries) holds the run as failed until a later turn.completed;
 * turn.failed holds it for good (index.ts judgeAgentRun).
 */
export function codexProgressLine(line: string, state: AgentProgress, root: string): string | undefined {
  const raw = line.trim();
  if (!raw) return undefined;
  let ev: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ev = parsed as Record<string, unknown>;
  } catch { /* plain text */ }
  if (!ev) { state.raw += 1; return short(scrubPaths(raw, root), 200); }
  const type = typeof ev.type === 'string' ? ev.type : '';
  const s = seenOf(state);
  if (!KNOWN.has(type)) {
    state.raw += 1;
    if (s.events.has(type) || s.events.size >= NAMED_MAX) return undefined;
    s.events.add(type);
    return `event  ${type ? short(type, 40) : 'without a type'}: not one Timmy reads (kept in the transcript)`;
  }
  state.structured += 1;
  const say = (t: string, n = 120): string => short(scrubPaths(t, root), n);
  if (type === 'thread.started') return 'started';
  if (type === 'turn.started') return undefined;
  if (type === 'turn.completed') {
    state.reportedEnd = 'completed';
    if (s.tentative) { delete state.reportedError; s.tentative = false; }
    const u = obj(ev.usage);
    const input = num(u.input_tokens);
    const output = num(u.output_tokens);
    if (input !== undefined || output !== undefined) state.usage = { input: input ?? 0, cached: num(u.cached_input_tokens) ?? 0, output: output ?? 0 };
    return `done  turn completed${state.usage ? ` · ${tokenText(state.usage)}` : ''}`;
  }
  if (type === 'turn.failed') {
    const msg = text(obj(ev.error).message) ?? text(ev.message);
    state.reportedEnd = 'failed';
    state.reportedError = msg ? say(msg, 160) : 'its turn failed';
    s.tentative = false;
    return `error  ${state.reportedError}`;
  }
  if (type === 'error') {
    const msg = say(text(ev.message) ?? text(obj(ev.error).message) ?? 'an error without a message', 160);
    if (state.reportedEnd !== 'failed') { state.reportedError = msg; s.tentative = true; }
    return `error  ${msg}`;
  }
  // item.started, item.updated, item.completed
  const item = obj(ev.item);
  const kind = String(item.type ?? item.item_type ?? '');
  const done = type === 'item.completed';
  switch (kind) {
    case 'agent_message':
    case 'assistant_message': {
      const t = typeof item.text === 'string' ? item.text : typeof item.message === 'string' ? item.message : undefined;
      if (!done || !t?.trim()) return undefined;
      state.lastText = t;
      state.finalMessage = t;
      return `says  ${say(t)}`;
    }
    case 'reasoning':
      return undefined;
    case 'command_execution': {
      if (!done) return undefined;
      state.toolCalls += 1;
      const cmd = Array.isArray(item.command) ? item.command.map(String).join(' ') : String(item.command ?? '');
      const status = String(item.status ?? '');
      const exit = num(item.exit_code);
      if (status === 'failed') state.toolErrors += 1;
      if (/^(declined|denied|rejected)$/.test(status)) state.denied.push('command_execution');
      return `command  ${say(cmd, 80)}${exit !== undefined ? `  exit ${exit}` : ''}${status && status !== 'completed' ? `  ${status}` : ''}`;
    }
    case 'file_change': {
      if (!done) return undefined;
      state.toolCalls += 1;
      const failed = String(item.status ?? '') === 'failed';
      if (failed) state.toolErrors += 1;
      // A change that failed named its files but did not write them: shown, not counted as edited.
      const names = (Array.isArray(item.changes) ? item.changes : []).map((c) => {
        const p = obj(c).path;
        if (failed) return typeof p === 'string' ? projectRel(root, p) ?? '<outside the project>' : undefined;
        return noteFile(state, root, p);
      }).filter((n): n is string => Boolean(n));
      return `files${failed ? ' failed' : ''}  ${names.join(', ') || '(no paths named)'}`;
    }
    case 'mcp_tool_call': {
      if (!done) return undefined;
      state.toolCalls += 1;
      const failed = String(item.status ?? '') === 'failed' || Object.keys(obj(item.error)).length > 0;
      if (failed) state.toolErrors += 1;
      return `tool  ${short(`${String(item.server ?? 'mcp')}.${String(item.tool ?? 'tool')}`, 60)}${failed ? '  failed' : ''}`;
    }
    case 'web_search': {
      if (!done) return undefined;
      state.toolCalls += 1;
      return `search  ${say(String(item.query ?? ''), 80)}`;
    }
    case 'todo_list': {
      const items = Array.isArray(item.items) ? item.items : [];
      const n = items.length;
      if (type === 'item.started') return `plan  ${n} step${n === 1 ? '' : 's'}`;
      return done ? `plan  ${items.filter((i) => obj(i).completed === true).length} of ${n} done` : undefined;
    }
    case 'error':
      // "a non-fatal error surfaced as an item" (codex-rs): shown; the turn's own end decides the run.
      return done ? `warning  ${say(text(item.message) ?? 'an error item without a message', 160)}` : undefined;
    default:
      if (s.items.has(kind) || s.items.size >= NAMED_MAX) return undefined;
      s.items.add(kind);
      return `item  ${kind ? short(kind, 40) : 'without a type'}: not one Timmy reads (kept in the transcript)`;
  }
}

// ── /agent and /tools ─────────────────────────────────────────────────────────────

/** The local route in `/agent`'s list: how it would run here, or what it needs. Nothing is contacted. */
export function codexLocalSummary(env: Env): { text: string; ready: boolean } {
  const model = set(env.TIMMY_AGENT_MODEL) ? env.TIMMY_AGENT_MODEL.trim() : null;
  if (!model) return { text: '--local: needs TIMMY_AGENT_MODEL (a model from ollama list)', ready: false };
  const baseUrl = set(env.TIMMY_AGENT_BASE_URL) ? env.TIMMY_AGENT_BASE_URL.trim() : DEFAULT_BASE_URL;
  const ep = endpointClass(baseUrl, model);
  if (!ep.local) return { text: `--local: refused here: ${ep.why}`, ready: false };
  return { text: `--local: model ${model} on this machine's Ollama (${ep.where}), no charge`, ready: true };
}

export const CODEX_INSTALL = 'brew install --cask codex (or npm install -g @openai/codex)';

/**
 * Its /tools row (kind harness): installed when codex is on PATH and the route's settings are local; "implemented;
 * not run" until a sealed, completed run of this route (exercisedBy agent:codex-local; a paid Codex run never counts).
 */
export function codexLocalCapabilityRow(o: { env: Env; onPath: (bin: string) => boolean; exercisedAt?: string }): {
  id: string; kind: 'harness'; name: string; rung: 'installed' | 'needs setup'; detail: string; setup?: string; exercisedBy: string;
} {
  const base = { id: CODEX_LOCAL_ROUTE, kind: 'harness' as const, name: 'Codex, local model', exercisedBy: `agent:${CODEX_LOCAL_ROUTE}` };
  const ran = Boolean(o.exercisedAt);
  const state = ran ? 'ran here' : 'implemented; not run';
  if (!o.onPath('codex')) return { ...base, rung: 'needs setup', detail: `codex is not on PATH; ${state}`, setup: CODEX_INSTALL };
  const model = set(o.env.TIMMY_AGENT_MODEL) ? o.env.TIMMY_AGENT_MODEL.trim() : null;
  if (!model) return { ...base, rung: 'needs setup', detail: `no local model named; ${state}`, setup: 'set TIMMY_AGENT_MODEL to a model from ollama list' };
  const ep = endpointClass(set(o.env.TIMMY_AGENT_BASE_URL) ? o.env.TIMMY_AGENT_BASE_URL.trim() : DEFAULT_BASE_URL, model);
  if (!ep.local) return { ...base, rung: 'needs setup', detail: `not local: ${ep.why}; ${state}`, setup: 'a non-cloud TIMMY_AGENT_MODEL on 127.0.0.1 (TIMMY_AGENT_BASE_URL)' };
  return {
    ...base, rung: 'installed',
    detail: ran
      ? `/agent codex --local <task>: a job; free on this machine's Ollama (${model})`
      : `implemented; not run: /agent codex --local <task>, free on this machine's Ollama (${model})`,
  };
}
