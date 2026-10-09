/**
 * What Timmy can do here (round R1, plan F-0): one row per surface, model, agent tool, other agent and
 * adapter, each placed on the ladder of AGENTS.md §8 from a check that is free, quick, writes nothing and
 * prints no secret:
 *
 *   reachable    a live check answered just now
 *   installed    what it needs is here (a program, a key, a file); nothing was contacted
 *   needs setup  built, but something it needs is missing; `setup` is the step that adds it
 *   not built    planned, or a stub that cannot do its job here
 *
 * "Exercised" is said beside the rung, from the sealed receipts: the last time one of the row's tools
 * completed in a turn. A past use is not a present check, so it never raises the rung.
 */
import { agentExercisedAt } from '../code-agents/index.js';
import { mcpCapabilityRows } from '../connectors/mcp-cli.js';
import { nativeCapabilityRows, nativeExercisedAt, type NativeRunIndex } from '../native/index.js';
import type { StudioHealth } from '../studio/health.js';
import { keySet } from '../utils/keys.js';

export type Kind = 'surface' | 'model' | 'tool' | 'harness' | 'adapter';
export type Rung = 'reachable' | 'installed' | 'needs setup' | 'not built';
/** OpenRouter's answer to the key check; `not-asked` when the caller could not read the key itself. */
export type OpenRouterAnswer = 'accepted' | 'rejected' | 'unreachable' | 'no-key' | 'not-asked';

export interface CapabilityRow {
  id: string;
  kind: Kind;
  name: string;
  rung: Rung;
  /** Its state in a few words. */
  detail: string;
  /** The step that sets it up, when it needs setup. */
  setup?: string;
  /** The agent tools this row covers, by name. */
  tools?: string[];
  /** The last time one of its tools completed in a sealed turn (ISO time). */
  exercised?: string;
  /**
   * R3 (finding 6): what decides `exercised` when its tools are shared with other rows: `native:<app>`, a
   * sealed receipt of that app judged ok (src/native nativeExercisedAt), never the shared tool's name.
   */
  exercisedBy?: string;
}

type Env = Record<string, string | undefined>;

/** Everything the checks read, so a test can stand in for the machine. */
export interface ProbeDeps {
  env: Env;
  onPath: (program: string) => boolean;
  exists: (path: string) => boolean;
  /** Whether Timmy Canvas's page bundle is built. */
  canvasBuilt: () => boolean;
  studio: () => Promise<StudioHealth>;
  studioBase: string;
  ollama: () => Promise<{ ok: boolean; models: string[] }>;
  openrouter: () => Promise<OpenRouterAnswer>;
  /** Where the REPL finds its model key ('environment', 'settings', ...), never the key. */
  modelKeySource: () => string | null;
  model: string;
  /** A GET's status, or null when nothing answered in time. */
  http: (url: string, timeoutMs: number) => Promise<number | null>;
  /** The lanes; `key` names the environment variable an API lane needs (its command alone is not enough). */
  lanes: () => Array<{ id: string; label: string; available: boolean; install?: string; key?: string }>;
  adapters: () => Array<{ id: string; name: string; installedAdapter: boolean }>;
  receipts: () => { ok: boolean; count: number; reason?: string };
  /**
   * Tool name → the last time it completed in a sealed turn whose outcomes came from the tool's own
   * answer (outcome rule 2), in a chain that verifies. Older receipts sealed every step completed.
   */
  exercised: () => Map<string, string>;
  /**
   * R3: each native app's sealed runs (src/native nativeRunIndex over the verified chain), and a project's
   * submissions not judged yet. Absent: the native rows say nothing of runs and are never exercised.
   */
  nativeRuns?: () => NativeRunIndex;
  /**
   * Round R3 (/agent): agent name → the newest sealed receipt of a completed run of that agent (src/code-agents
   * agentExercisedIndex over the verified chain). Absent: the agent rows are never exercised.
   */
  agentRuns?: () => Map<string, string>;
  /** Whether the edge host (TIMMY_EDGE_HOST or the private overlay) is set; never the host. */
  edgeSet: () => boolean;
}

export const KIND_TITLES: Record<Kind, string> = {
  surface: 'WHERE YOU WORK',
  model: 'MODELS',
  tool: 'AGENT TOOLS',
  harness: 'OTHER AGENTS',
  adapter: 'NATIVE APPS AND ADAPTERS',
};

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

type Row = Omit<CapabilityRow, 'exercised'>;

export async function capabilities(d: ProbeDeps, opts: { all?: boolean } = {}): Promise<CapabilityRow[]> {
  const env = d.env;
  // The slow checks run together; each has its own short timeout.
  const [studio, ollama, openrouter, taskforge, missionMap] = await Promise.all([
    d.studio(),
    d.ollama(),
    d.modelKeySource() ? d.openrouter() : Promise.resolve<OpenRouterAnswer>('no-key'),
    keySet(env.TASKFORGE_API_URL) ? d.http(`${env.TASKFORGE_API_URL!.replace(/\/+$/, '')}/runtime/health`, 800) : Promise.resolve(null),
    d.http('http://127.0.0.1:4336/api/vision/status', 600),
  ]);
  const page = `${d.studioBase}/`;
  const keySource = d.modelKeySource();
  const rows: Row[] = [];
  const add = (r: Row): void => void rows.push(r);
  const program = (id: string, kind: Kind, name: string, bin: string, ok: string, setup: string, tools?: string[]): void =>
    add(d.onPath(bin) ? { id, kind, name, rung: 'installed', detail: ok, ...(tools ? { tools } : {}) } : { id, kind, name, rung: 'needs setup', detail: `${bin} is not on PATH`, setup, ...(tools ? { tools } : {}) });

  // ── where you work
  add(keySource
    ? { id: 'repl', kind: 'surface', name: 'REPL (timmy)', rung: 'installed', detail: `model key from ${keySource === 'environment' ? 'the environment' : keySource}` }
    : { id: 'repl', kind: 'surface', name: 'REPL (timmy)', rung: 'needs setup', detail: 'no model key', setup: 'timmy init, or export OPENROUTER_API_KEY' });
  if (studio.state === 'running') {
    add({ id: 'canvas', kind: 'surface', name: 'Timmy Canvas (/canvas)', rung: 'reachable', detail: `${page} · ${studio.pageConnected === true ? 'page open' : studio.pageConnected === false ? 'no page open: /canvas open' : 'page state unknown'}` });
  } else if (studio.state === 'other') {
    add({ id: 'canvas', kind: 'surface', name: 'Timmy Canvas (/canvas)', rung: 'needs setup', detail: `${page} is another program`, setup: 'set TIMMY_STUDIO_PORT to a free port' });
  } else if (d.canvasBuilt()) {
    add({ id: 'canvas', kind: 'surface', name: 'Timmy Canvas (/canvas)', rung: 'installed', detail: 'not running: /canvas starts it' });
  } else {
    add({ id: 'canvas', kind: 'surface', name: 'Timmy Canvas (/canvas)', rung: 'needs setup', detail: 'the page is not built', setup: 'npm run build:canvas' });
  }
  add({ id: 'monitor', kind: 'surface', name: 'Monitor (timmy watch)', rung: 'installed', detail: 'full screen: /watch opens it' });
  const mux = d.onPath('zellij') ? 'zellij' : d.onPath('tmux') ? 'tmux' : null;
  add(mux
    ? { id: 'cockpit', kind: 'surface', name: 'Cockpit (timmy center)', rung: 'installed', detail: `tabs in ${mux}` }
    : { id: 'cockpit', kind: 'surface', name: 'Cockpit (timmy center)', rung: 'needs setup', detail: 'no zellij or tmux', setup: 'brew install zellij (or tmux)' });
  // /web opens a pane only when Timmy itself runs inside zellij or tmux (src/repl/web.ts); otherwise a link.
  const inMux = env.ZELLIJ !== undefined || Boolean(env.TMUX);
  add(d.onPath('carbonyl')
    ? { id: 'web', kind: 'surface', name: 'Web views (/web)', rung: 'installed',
        detail: inMux ? 'pages in a pane here (carbonyl)' : mux ? `links here; pages when run inside ${mux}` : 'links only: pages need zellij or tmux' }
    : { id: 'web', kind: 'surface', name: 'Web views (/web)', rung: 'installed', detail: 'links only: carbonyl shows pages here', setup: 'npm install --global carbonyl' });
  add(d.onPath('upmd')
    ? { id: 'workflows', kind: 'surface', name: 'Workflows (/workflows)', rung: 'installed', detail: 'upmd runs named Markdown blocks as jobs' }
    : { id: 'workflows', kind: 'surface', name: 'Workflows (/workflows)', rung: 'needs setup', detail: 'upmd is not installed', setup: 'brew install rezigned/tap/upmd' });
  const chain = d.receipts();
  add({ id: 'receipts', kind: 'surface', name: 'Receipts (timmy receipts)', rung: 'installed', detail: !chain.ok ? `chain BROKEN: ${chain.reason ?? 'verification failed'}` : chain.count ? `${plural(chain.count, 'receipt')}, chain verified` : 'none yet' });

  // ── models
  const or: Record<OpenRouterAnswer, Row> = {
    'accepted': { id: 'openrouter', kind: 'model', name: 'OpenRouter', rung: 'reachable', detail: `key accepted · ${d.model}` },
    'rejected': { id: 'openrouter', kind: 'model', name: 'OpenRouter', rung: 'needs setup', detail: 'the key was refused', setup: 'timmy init with a working key' },
    'unreachable': { id: 'openrouter', kind: 'model', name: 'OpenRouter', rung: 'installed', detail: 'key set; openrouter.ai did not answer' },
    'no-key': { id: 'openrouter', kind: 'model', name: 'OpenRouter', rung: 'needs setup', detail: 'no model key', setup: 'timmy init, or export OPENROUTER_API_KEY' },
    'not-asked': { id: 'openrouter', kind: 'model', name: 'OpenRouter', rung: 'installed', detail: 'key set; not contacted' },
  };
  add(or[openrouter]);
  add(ollama.ok
    ? { id: 'ollama', kind: 'model', name: 'Ollama (local models)', rung: 'reachable', detail: plural(ollama.models.length, 'local model') }
    : d.onPath('ollama')
      ? { id: 'ollama', kind: 'model', name: 'Ollama (local models)', rung: 'installed', detail: 'no answer, or no local model: ollama serve' }
      : { id: 'ollama', kind: 'model', name: 'Ollama (local models)', rung: 'needs setup', detail: 'not installed', setup: 'brew install ollama; brew services start ollama; ollama pull <model>' });

  // ── agent tools (what the REPL's agent can call; NEEDS YOU asks before the risky ones)
  add({ id: 'builtin', kind: 'tool', name: 'Built-in tools', rung: 'installed', detail: 'time, math, system, env (asks), spatial files', tools: ['get_current_time', 'calculate', 'get_system_info', 'get_env', 'read_spatial_model_context'] });
  add({ id: 'project-files', kind: 'tool', name: 'Project files', rung: 'installed', detail: 'list, read, write (asks) in the project', tools: ['list_project_files', 'read_project_file', 'write_project_file'] });
  const canvasTools = ['canvas_exec', 'canvas_read', 'canvas_api'];
  // Reachable only when a page answered: the tools draw in the page, not in the server (review finding).
  add(studio.state === 'running' && studio.pageConnected === true
    ? { id: 'canvas-tools', kind: 'tool', name: 'Canvas tools', rung: 'reachable', detail: 'drawing on the open canvas page', tools: canvasTools }
    : studio.state === 'running' && studio.pageConnected === null
      ? { id: 'canvas-tools', kind: 'tool', name: 'Canvas tools', rung: 'installed', detail: 'canvas running; an older Timmy Canvas cannot say if a page is open', tools: canvasTools }
      : studio.state === 'running'
        ? { id: 'canvas-tools', kind: 'tool', name: 'Canvas tools', rung: 'needs setup', detail: 'no canvas page open', setup: '/canvas open', tools: canvasTools }
        : { id: 'canvas-tools', kind: 'tool', name: 'Canvas tools', rung: 'needs setup', detail: 'Timmy Canvas is not running', setup: '/canvas, then /canvas open', tools: canvasTools });
  add({ id: 'workspace', kind: 'tool', name: 'Workspace command', rung: 'installed', tools: ['run_in_daytona_workspace'],
    detail: keySet(env.DAYTONA_API_KEY) ? 'runs in Daytona (asks each time)' : 'runs on this machine (asks each time)' });
  program('browser', 'tool', 'Browser (agent-browser)', 'agent-browser', 'drives a Chrome session', 'brew install agent-browser, then agent-browser install', ['browser_launch_cdp', 'browser_get_snapshot', 'browser_click_element', 'browser_take_screenshot']);
  program('stress', 'tool', 'Load test (oha)', 'oha', 'oha is on PATH (asks first)', 'brew install oha', ['stress_test_endpoint']);
  add(keySet(env.TRIGGER_SECRET_KEY)
    ? { id: 'trigger', kind: 'tool', name: 'Trigger.dev jobs', rung: 'installed', detail: 'key set; not contacted', tools: ['trigger_background_workflow'] }
    : { id: 'trigger', kind: 'tool', name: 'Trigger.dev jobs', rung: 'needs setup', detail: 'no key', setup: 'set TRIGGER_SECRET_KEY', tools: ['trigger_background_workflow'] });
  add(keySet(env.COMPOSIO_API_KEY)
    ? { id: 'composio', kind: 'tool', name: 'Composio', rung: 'installed', detail: 'lists connections; the rest not built', tools: ['manage_composio_integrations'] }
    : { id: 'composio', kind: 'tool', name: 'Composio', rung: 'needs setup', detail: 'no key', setup: 'set COMPOSIO_API_KEY', tools: ['manage_composio_integrations'] });
  add(d.edgeSet()
    ? { id: 'pulse', kind: 'tool', name: 'Durable Object pulse', rung: 'installed', detail: 'edge host set; not contacted', tools: ['cloudflare_send_durable_pulse'] }
    : { id: 'pulse', kind: 'tool', name: 'Durable Object pulse', rung: 'needs setup', detail: 'no edge host', setup: 'set TIMMY_EDGE_HOST', tools: ['cloudflare_send_durable_pulse'] });
  add({ id: 'flag', kind: 'tool', name: 'Feature flags', rung: 'not built', detail: 'needs a Worker binding; not readable here', tools: ['cloudflare_get_feature_flag'] });
  add(keySet(env.BREAK_MODE_API_BASE_URL ?? env.API_BASE_URL) && keySet(env.TIMMY_USERNAME)
    ? { id: 'listing', kind: 'tool', name: 'Card listing', rung: 'installed', detail: 'posts listings (asks first)', tools: ['list_card'] }
    : { id: 'listing', kind: 'tool', name: 'Card listing', rung: 'needs setup', detail: 'no listing service', setup: 'set BREAK_MODE_API_BASE_URL and TIMMY_USERNAME', tools: ['list_card'] });
  const spatial = ['list_local_spatial_models', 'review_spatial_with_local_model'];
  add(ollama.ok
    ? { id: 'spatial-review', kind: 'tool', name: 'Local spatial review', rung: 'reachable', detail: 'on the local Ollama models', tools: spatial }
    : { id: 'spatial-review', kind: 'tool', name: 'Local spatial review', rung: 'needs setup', detail: 'needs a local Ollama model', setup: 'ollama serve, then ollama pull <model>', tools: spatial });

  // ── other agents
  // Round R3 (helper H13): each runs from the REPL as a job (/agent); its row is exercised only by a sealed,
  // completed run of that agent (exercisedBy agent:<name>, src/code-agents agentExercisedIndex), never another's.
  const paidHand = (n: string): string => `/agent ${n} --paid <task>: a job, on your account (costs money)`;
  program('claude-code', 'harness', 'Claude Code', 'claude', paidHand('claude'), 'brew install --cask claude-code');
  program('codex', 'harness', 'Codex', 'codex', paidHand('codex'), 'brew install --cask codex (or npm install -g @openai/codex)');
  add(d.onPath('qwen') || d.onPath('qwen-code')
    ? { id: 'qwen-code', kind: 'harness', name: 'Qwen Code', rung: 'installed', detail: '/agent qwen <task>: a job; free on a local endpoint' }
    : { id: 'qwen-code', kind: 'harness', name: 'Qwen Code', rung: 'needs setup', detail: 'qwen is not on PATH', setup: 'brew install qwen-code (or npm install -g @qwen-code/qwen-code)' });
  program('opencode', 'harness', 'OpenCode', 'opencode', paidHand('opencode'), 'brew install opencode (or npm install -g opencode-ai)');
  const AGENT_ROWS: Record<string, string> = { 'claude-code': 'agent:claude', codex: 'agent:codex', 'qwen-code': 'agent:qwen', opencode: 'agent:opencode' };
  for (const r of rows) if (AGENT_ROWS[r.id]) r.exercisedBy = AGENT_ROWS[r.id];
  // An API lane runs curl with its key: curl on PATH is not enough (review finding).
  const lanes = d.lanes().map((l) => ({ ...l, keyMissing: Boolean(l.key) && !keySet(env[l.key!]) }));
  const ready = lanes.filter((l) => l.available && !l.keyMissing).length;
  add({ id: 'lanes', kind: 'harness', name: 'Lanes (/lanes)', rung: ready ? 'installed' : 'needs setup', detail: `${ready} of ${lanes.length} installed`, ...(ready ? {} : { setup: '/lanes lists how to install each' }) });
  if (opts.all) {
    for (const l of lanes) {
      add(!l.available
        ? { id: `lane:${l.id}`, kind: 'harness', name: `  ${l.label}`, rung: 'needs setup', detail: 'not on PATH', setup: l.install ?? 'see /lanes' }
        : l.keyMissing
          ? { id: `lane:${l.id}`, kind: 'harness', name: `  ${l.label}`, rung: 'needs setup', detail: 'no key', setup: `set ${l.key}` }
          : { id: `lane:${l.id}`, kind: 'harness', name: `  ${l.label}`, rung: 'installed', detail: l.key ? 'key set; not contacted' : 'its command is on PATH' });
    }
  }
  add(keySet(env.AGENTPASS_REPO_PATH) && d.exists(env.AGENTPASS_REPO_PATH!)
    ? { id: 'agentpass', kind: 'harness', name: 'AgentPass', rung: 'installed', detail: 'checkout found; not contacted' }
    : { id: 'agentpass', kind: 'harness', name: 'AgentPass', rung: 'needs setup', detail: 'service lives outside this repo', setup: 'set AGENTPASS_REPO_PATH to its checkout' });
  add(!keySet(env.TASKFORGE_API_URL)
    ? { id: 'taskforge', kind: 'harness', name: 'TaskForge', rung: 'needs setup', detail: 'no API address', setup: 'set TASKFORGE_API_URL to its API' }
    : taskforge === 200
      ? { id: 'taskforge', kind: 'harness', name: 'TaskForge', rung: 'reachable', detail: 'its health check answered' }
      : { id: 'taskforge', kind: 'harness', name: 'TaskForge', rung: 'installed', detail: taskforge === null ? 'address set; no answer' : `address set; health HTTP ${taskforge}` });

  // Round R2: MCP servers through two command-line routes, and image observations.
  for (const r of mcpCapabilityRows(d.env, { onPath: (p) => d.onPath(p) })) add(r);
  add(d.onPath('python3')
    ? { id: 'look', kind: 'tool', name: 'Image observations (/observe)', rung: 'installed', detail: 'OpenCV measurements (workers/look); OpenCV is checked when it runs', tools: ['observe_image', 'describe_image'] }
    : { id: 'look', kind: 'tool', name: 'Image observations (/observe)', rung: 'needs setup', detail: 'python3 is not on PATH', setup: 'brew install python && pip3 install opencv-python-headless', tools: ['observe_image', 'describe_image'] });

  // ── adapters
  const nativeRuns = d.nativeRuns?.();
  for (const r of nativeCapabilityRows(d.env, {}, nativeRuns)) add(r);
  add(missionMap === 200
    ? { id: 'mission-map', kind: 'adapter', name: 'Mission Map (timmy map)', rung: 'reachable', detail: 'http://127.0.0.1:4336/' }
    : { id: 'mission-map', kind: 'adapter', name: 'Mission Map (timmy map)', rung: 'installed', detail: 'not running: timmy map' });
  const adapters = d.adapters();
  const found = adapters.filter((a) => a.installedAdapter).length;
  add({ id: 'adapters', kind: 'adapter', name: 'Vision adapters', rung: found ? 'installed' : 'needs setup', detail: `${found} of ${adapters.length} found; a probe run qualifies one`, ...(found ? {} : { setup: 'timmy vision integrations list' }) });
  if (opts.all) {
    for (const a of adapters) {
      add(a.installedAdapter
        ? { id: `adapter:${a.id}`, kind: 'adapter', name: `  ${a.name}`, rung: 'installed', detail: 'files found; not run' }
        : { id: `adapter:${a.id}`, kind: 'adapter', name: `  ${a.name}`, rung: 'needs setup', detail: 'its runtime is missing', setup: 'timmy vision integrations list' });
    }
  }

  // Exercised: the last sealed, completed use of any of the row's tools; a row keyed by its own record
  // (exercisedBy) is decided by that record alone, never by a tool name it shares (R3, finding 6).
  const used = d.exercised();
  const agentRuns = d.agentRuns?.();
  return rows.map((r) => {
    if (r.exercisedBy?.startsWith('agent:')) {
      const at = agentExercisedAt(r.exercisedBy, agentRuns);
      return at ? { ...r, exercised: at } : r;
    }
    if (r.exercisedBy) {
      const at = nativeExercisedAt(r.exercisedBy, nativeRuns);
      return at ? { ...r, exercised: at } : r;
    }
    const last = (r.tools ?? []).map((t) => used.get(t)).filter((t): t is string => Boolean(t)).sort().at(-1);
    return last ? { ...r, exercised: last } : r;
  });
}
