import { OpenRouter } from '@openrouter/sdk';
import { tool } from '@openrouter/sdk/lib/tool.js';
import { stepCountIs, maxCost } from '@openrouter/sdk/lib/stop-conditions.js';
import type { StreamableOutputItem } from '@openrouter/sdk/lib/stream-transformers.js';
import { EventEmitter } from 'eventemitter3';
import type { AgentEvents } from './events.js';
import type { Message, AgentConfig } from '../types/index.js';
import { ConversationManager } from './conversation.js';
import { redactString } from '../utils/redact.js';
import { defaultTools, optedInTools } from './tools.js';
import { publish as appendEvent } from '../bus/index.js';
import { execSync, execFileSync } from 'child_process';
import { classifyCommand } from '../utils/safety.js';
import fs from 'fs';
import path from 'path';
import { MultiplexerManager } from './multiplexer.js';
import { ZellijManager } from './zellij.js';
import { RmuxManager } from './rmux.js';
import { DEFAULT_LANE_BINDINGS, LANE_RUNNERS, laneStartupScript } from './lanes.js';
import { laneServerArgs, laneWatchdog, lanesWords, type LaneMultiplexer } from './lane-server.js';
import { writeLog, tuiLogger } from '../utils/logger.js';
import { carriesSecret, shownAddress, writeLaunchPage } from '../utils/launch-page.js';
import { probeOllama, pickOllamaModel, ollamaChatCompletion, getLocalOllamaBaseUrl } from './providers.js';
import { modelCheckUrl } from './model-check.js';
import { runLocalTurn, type LocalChatRoute, type LocalTurnResult } from './local-chat.js';
// R10 (H169): the route policy (free-only, local-only) every model call of a turn is checked against: the turn's own request,
// each fallback model, the last-resort local answer, and each tool that asks a model of its own (src/agent/route-policy.ts)
import { checkRoute, policyTools, PolicyRefusedError, routePolicyNow, type RoutePolicy } from './route-policy.js';

export interface SendOptions {
  /** Cancels the turn: the stream is cancelled and no fallback model is tried. */
  signal?: AbortSignal;
  /** Retry 429, 5xx and connection errors with exponential backoff from 1s (1s, 2s, 4s), giving up after 7.5s (playbook §17.8). */
  retry?: boolean;
}

/**
 * R4 (H103, D1): a message with no route to a model: off the chat's local route with no model key, Agent.send refuses it
 * before anything else (before the conversation takes it, before any request): never a request to OpenRouter with an empty
 * key, and never the last-resort fallback (a local model nobody chose). `sent` is false: nothing left this process.
 */
export class NoModelKeyError extends Error {
  readonly sent = false as const;
  constructor() {
    super([
      'No model key, so nothing was sent to any model.',
      'Reason: the chat is set to OpenRouter (the setup did not choose the local model), and no OPENROUTER_API_KEY is set or stored.',
      'Next: timmy init --chat openrouter (it asks for the key, hidden), or the local model: timmy init --chat local --model <name>.',
    ].join('\n'));
    this.name = 'NoModelKeyError';
  }
}

/**
 * R11 (H169, Phase 0 item 1): a key, and no OpenRouter model chosen: nothing is sent, before the conversation takes the message
 * and before any request. There is no shipped default any more (src/utils/config.ts): a surface's own check says it first
 * (src/agent/chat-route.ts NO_MODEL_CHOSEN_REFUSAL); this one holds for any caller that has none.
 */
export class NoModelChosenError extends Error {
  readonly sent = false as const;
  constructor() {
    super([
      'No model chosen. /model <id> chooses one (/model free lists free ones).',
      'Reason: an OpenRouter key is set up, and no model is chosen for the next turn: nothing is sent to a model nobody chose.',
      'Next: Models (M) in timmy workbench, /model <id> in the REPL (timmy), or timmy init --chat openrouter --model <id>. Nothing was sent to any model.',
    ].join('\n'));
    this.name = 'NoModelChosenError';
  }
}

/** R4 (H103, D1c): a turn the last-resort fallback answered: this computer's Ollama, its model, and why OpenRouter did not. */
export interface LastResortAnswer {
  /** the Ollama model that answered (local weights: pickOllamaModel never picks a cloud-backed one) */
  model: string;
  /** the Ollama it asked: this computer's (getLocalOllamaBaseUrl takes a loopback address only) */
  host: string;
  /** OpenRouter's failure, in a line */
  cause: string;
}

/** A cause in one bounded line (the notice and the receipt quote it). */
const oneLine = (s: unknown, max = 160): string => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

export interface AgentOptions {
  /**
   * Which multiplexer runs background lanes. R4 (H87): 'none' unless a caller passes the operator's choice (the monitor's
   * `--lanes`, src/agent/lane-server.ts): no lane session and no lane program starts for anyone who did not ask.
   */
  multiplexer?: LaneMultiplexer;
}

/** No background lanes: every call is a no-op. */
class NoMultiplexer implements MultiplexerManager {
  init(): void {}
  spawnSession(): void {}
  killSession(): void {}
  getCwd(): string { return process.cwd(); }
  capturePane(): string[] { return []; }
  async sendCommand(): Promise<void> {}
  poll(): void {}
  destroy(): void {}
}

class TmuxManager implements MultiplexerManager {
  private pollInterval: NodeJS.Timeout | null = null;
  private lastOutputs: Map<string, string[]> = new Map();
  private agent: Agent;
  private activeCommands: Map<string, {
    rawCommand: string;
    wrappedCommand: string;
    sessionId: string;
    sessionName: string;
    cwdBefore: string;
    startedAt: string;
  }> = new Map();

  /** R4 (H87): this process's own tmux server (`-L timmy-lanes-<pid>`, no configuration of the operator's), never the default one. */
  private readonly server = laneServerArgs();
  /** R4 (H87): the sessions this process made there: the only ones it ever ends. */
  private readonly made = new Set<string>();
  private watched = false;

  constructor(agent: Agent) {
    this.agent = agent;
  }

  init() {
    // Pre-spawn standard sessions on startup (on this process's own server: nothing of anyone else's is there to clean up)
    for (const session of this.agent.tmuxSessions) {
      this.spawnSession(session.id);
    }
    if (this.made.size > 0 && this.agent.logsEnabled !== false) tuiLogger.info(`[lanes.started] ${lanesWords('tmux')}`);
    // Start non-blocking polling thread
    const pollMs = process.env.TIMMY_TMUX_POLL_MS ? parseInt(process.env.TIMMY_TMUX_POLL_MS, 10) : 500;
    this.pollInterval = setInterval(() => this.poll(), pollMs);
  }

  /** R4 (H87): ends the sessions this process made, on its own server; never another session, never another server. */
  cleanupOrphaned() {
    for (const s of [...this.made]) {
      try { execFileSync('tmux', [...this.server, 'kill-session', '-t', s], { stdio: 'ignore' }); } catch { /* already gone */ }
      this.made.delete(s);
    }
  }

  spawnSession(id: string) {
    const sName = `ortui-${id}`;
    try {
      execFileSync('tmux', [...this.server, 'new-session', '-d', '-s', sName], { stdio: 'ignore' });
      this.made.add(sName);
      this.lastOutputs.set(id, []);
      // R4 (H87): once, a watchdog on the server ends it when this process is gone (a monitor killed with no exit handler)
      if (!this.watched) {
        this.watched = true;
        try { execFileSync('tmux', laneWatchdog('tmux'), { stdio: 'ignore' }); } catch { /* the exit handler still ends them */ }
      }

      const runnerKey = DEFAULT_LANE_BINDINGS[id];

      const startup = laneStartupScript(runnerKey);
      execFileSync('tmux', [...this.server, 'send-keys', '-t', sName, startup, 'C-m'], { stdio: 'ignore' });
    } catch {
      // Ignore errors
    }
  }

  killSession(id: string) {
    const sName = `ortui-${id}`;
    try {
      execFileSync('tmux', [...this.server, 'kill-session', '-t', sName], { stdio: 'ignore' });
      this.made.delete(sName);
      this.lastOutputs.delete(id);
    } catch {}
  }

  getCwd(id: string): string {
    const sName = `ortui-${id}`;
    try {
      return execFileSync('tmux', [...this.server, 'display-message', '-p', '-t', sName, '-F', '#{pane_current_path}'], { encoding: 'utf8', stdio: 'pipe' }).trim();
    } catch {
      return process.cwd();
    }
  }

  capturePane(id: string): string[] {
    const sName = `ortui-${id}`;
    try {
      const output = execFileSync('tmux', [...this.server, 'capture-pane', '-pt', sName], { encoding: 'utf8', stdio: 'pipe' });
      const lines = output.split('\n');
      while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
        lines.pop();
      }
      return lines;
    } catch {
      return [`[System Error] Failed to capture output buffer from tmux session "${sName}"`];
    }
  }

  async sendCommand(id: string, command: string, approved = false) {
    const safety = classifyCommand(command);

    if (safety.approvalRequired && !approved) {
      const runId = this.agent.currentRunId;
      this.agent.lastBlockedCommands.set(id, command);

      this.agent.emit('approval.required', {
        runId,
        sessionId: id,
        sessionName: this.agent.tmuxSessions.find(s => s.id === id)?.name || 'Unknown',
        command,
        riskLevel: safety.riskLevel,
        reason: safety.reason || 'Command requires explicit approval'
      });
      appendEvent('approval.required', { sessionId: id, command, riskLevel: safety.riskLevel });

      const prev = this.lastOutputs.get(id) || [];
      this.lastOutputs.set(id, [
        ...prev,
        `⚠️ [APPROVAL REQUIRED] ${safety.reason}`,
        `Type "approval.grant" to authorize and execute.`
      ]);
      this.agent.emit('tmux:update');
      return;
    }

    const sName = `ortui-${id}`;
    try {
      const runId = this.agent.currentRunId;
      const session = this.agent.tmuxSessions.find(s => s.id === id);
      const sessionName = session ? session.name : 'Unknown';

      if (approved) {
        // Clear the attention state — this lane no longer needs human eyes.
        this.agent.lastBlockedCommands.delete(id);

        this.agent.emit('approval.granted' as any, {
          runId,
          sessionId: id,
          sessionName,
          command,
          timestamp: new Date().toISOString()
        });
        appendEvent('approval.granted', { sessionId: id, command });
      }

      // Generate unique command ID
      const commandId = `cmd_${Math.random().toString(36).substring(2, 9)}`;

      // Capture CWD before executing
      const cwdBefore = this.getCwd(id);
      const startedAt = new Date().toISOString();

      // Wrap raw command to capture exact exitCode via unique command ID token
      const wrappedCommand = `( ${command} ); printf "\\nTIMMY_EXIT_CODE:${commandId}:%s\\n" "$?"`;

      // Log in command registry
      this.activeCommands.set(commandId, {
        rawCommand: command,
        wrappedCommand,
        sessionId: id,
        sessionName,
        cwdBefore,
        startedAt
      });

      this.agent.emit('tmux.command.sent', {
        runId,
        sessionId: id,
        sessionName,
        command,
        cwd: cwdBefore,
        timestamp: startedAt
      });

      // Send to tmux session using exact parameter array argument preservation
      execFileSync('tmux', [...this.server, 'send-keys', '-t', sName, wrappedCommand, 'C-m'], { stdio: 'ignore' });
      setTimeout(() => this.pollSession(id), 50);
    } catch {}
  }

  pollSession(id: string) {
    const currentLines = this.capturePane(id);
    const prevLines = this.lastOutputs.get(id) || [];

    let newLines: string[] = [];
    if (currentLines.length > prevLines.length) {
      newLines = currentLines.slice(prevLines.length);
    } else if (currentLines.length === prevLines.length) {
      const lastIdx = currentLines.length - 1;
      if (lastIdx >= 0 && currentLines[lastIdx] !== prevLines[lastIdx]) {
        newLines = [currentLines[lastIdx]];
      }
    } else {
      newLines = currentLines;
    }

    const session = this.agent.tmuxSessions.find(s => s.id === id);
    const sessionName = session ? session.name : 'Unknown';
    const runId = this.agent.currentRunId;

    for (const line of newLines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Scan for the command exit code token
      const exitCodeMatch = trimmed.match(/TIMMY_EXIT_CODE:([^:]+):(\d+)/);
      if (exitCodeMatch) {
        const cmdId = exitCodeMatch[1];
        const exitCode = parseInt(exitCodeMatch[2], 10);
        const success = exitCode === 0;

        const cmdData = this.activeCommands.get(cmdId);
        if (cmdData) {
          this.activeCommands.delete(cmdId);
          const exitCwd = this.getCwd(id);

          this.agent.emit('command.finished' as any, {
            runId,
            sessionId: id,
            sessionName,
            commandId: cmdId,
            command: cmdData.rawCommand,
            cwd: exitCwd,
            exitCode,
            success,
            timestamp: new Date().toISOString()
          });
        }
        continue; // Filter the TIMMY_EXIT_CODE marker out of telemetry output lines
      }

      this.agent.emit('tmux.output.line', {
        runId,
        sessionId: id,
        sessionName,
        line: trimmed,
        timestamp: new Date().toISOString()
      });
    }

    this.lastOutputs.set(id, currentLines);

    // Filter TIMMY_EXIT_CODE out of visual TUI logs
    const cleanLines = currentLines.filter(line => !line.includes('TIMMY_EXIT_CODE:'));
    this.agent.emit('tmux:log', {
      sessionId: id,
      logs: cleanLines
    });
  }

  poll() {
    for (const session of this.agent.tmuxSessions) {
      this.pollSession(session.id);
    }
  }

  destroy() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
    }
    this.cleanupOrphaned();
  }
}

export class Agent extends EventEmitter<AgentEvents> {
  private client: OpenRouter;
  private conversation: ConversationManager;
  private config: AgentConfig;
  private tools: ReturnType<typeof tool>[];
  private running = false;
  private tmuxMgr: MultiplexerManager;
  /** R4 (H87): which multiplexer runs this agent's lanes; 'none' (the default) runs none. */
  public readonly multiplexer: LaneMultiplexer;

  public currentRunId = 'default-local-run';
  public lastBlockedCommands: Map<string, string> = new Map();
  public modelHealthStatus: 'UNTESTED' | 'READY' | 'ERROR' | 'FALLBACK READY' = 'UNTESTED';
  /** Live file-logging switch — mirrored into the logger gate by OptionsPanel. */
  public logsEnabled: boolean = true;
  /** Which upstream is currently answering: openrouter, ollama, or none. */
  public activeProvider: 'openrouter' | 'ollama' | 'none' = 'none';
  /** Human-readable reason for the last health-check failure, shown in the UI. */
  public lastHealthError: string | undefined;

  // Persistent workspace chamber contexts (logs). Round R1: they start empty and hold only what a
  // pane actually printed; the seeded "verified" lines, which no run wrote, are gone (AGENTS.md §4).
  public workspaceContexts: Record<string, string[]> = { opencode: [], hermes: [], pi: [], openrouter: [] };

  // Unified active workspace VM thread logs relayed to Proof page: lines the panes actually printed.
  public relayedVmLogs: string[] = [];

  // TMUX Cluster & Background Workspace Session Tracker. Round R1 review: no memory or cost figures;
  // nothing measured them (the old fixed and random numbers were invented, AGENTS.md §4). R11 Phase 2 (H169, item b):
  // a lane's `model` is a label and nothing here runs a model, so the labels name none (the old ones named models nobody
  // chose and nothing asked: `/tmux list` says "no model named"); the lane names stay as they were.
  public tmuxSessions: Array<{ id: string; name: string; model: string }> = [
    { id: '1', name: 'OpenCode CLI', model: '' },
    { id: '2', name: 'Hermes CLI', model: '' },
    { id: '3', name: 'Pi Daemon', model: '' },
    { id: '4', name: 'Systems MCP', model: '' },
    { id: '5', name: 'jcode', model: '' },
    { id: '6', name: 'Minds CLI', model: '' }
  ];
  public showTmuxDropdown = false;

  constructor(config: AgentConfig, options: AgentOptions = {}) {
    super();
    this.client = new OpenRouter({ apiKey: config.apiKey });
    this.conversation = new ConversationManager();
    this.config = config;
    // R11 (H169, Phase 0 item 4): the default tools, and the opt-in ones only when TIMMY_TOOLS_OPT_IN names them
    this.tools = [...defaultTools, ...optedInTools()];

    // Initialize multiplexer background manager (tmux, zellij, or rmux). R4 (H87): 'none' unless the caller passes the
    // operator's choice (`timmy watch --lanes`): no lane session and no lane program for anyone who did not ask.
    const mux: LaneMultiplexer = options.multiplexer ?? 'none';
    this.multiplexer = mux;
    if (mux === 'none') {
      this.tmuxMgr = new NoMultiplexer();
    } else if (mux === 'zellij') {
      this.tmuxMgr = new ZellijManager(this);
    } else if (mux === 'rmux') {
      this.tmuxMgr = new RmuxManager(this);
    } else {
      this.tmuxMgr = new TmuxManager(this);
    }
    this.tmuxMgr.init();

    // Attach listener to capture tmux stdout and update persistent workspace threads
    this.on('tmux.output.line' as any, (data: any) => {
      const { sessionId, line } = data;
      const cleanLine = line.includes('TIMMY_EXIT_CODE:') ? null : line;
      if (cleanLine) {
        const current = this.workspaceContexts[sessionId] || [];
        this.workspaceContexts[sessionId] = [...current, cleanLine].slice(-10);

        this.relayedVmLogs.push(`[${sessionId.toUpperCase()}] ${cleanLine}`);
        if (this.relayedVmLogs.length > 100) {
          this.relayedVmLogs.shift();
        }
        this.emit('workspace:log:update' as any);
      }
    });

    // Browser pane lane requests from the UI
    this.on('workspace:add-browser-pane' as any, (url: string) => {
      this.addBrowserPane(typeof url === 'string' && url.length > 0 ? url : 'https://localhost:3001');
    });

    this.wireFileLogging();

    // Cleanup Tmux on process exit
    process.on('exit', () => this.tmuxMgr.destroy());
    process.on('SIGINT', () => {
      this.tmuxMgr.destroy();
      process.exit(0);
    });

    const sessions = this.conversation.listSessions();
    if (sessions.length > 0) {
      try {
        this.conversation.load(sessions[0]);
      } catch {
        this.conversation.startNew();
      }
    } else {
      this.conversation.startNew();
    }
  }

  sendTmuxCommand(sessionId: string, command: string, approved = false): void {
    this.tmuxMgr.sendCommand(sessionId, command, approved);
  }

  toggleTmuxDropdown(): void {
    this.showTmuxDropdown = !this.showTmuxDropdown;
    this.emit('tmux:update');
  }

  addTmuxSession(name: string, model: string): void {
    const id = (this.tmuxSessions.length + 1).toString();
    this.tmuxSessions.push({ id, name, model });
    this.tmuxMgr.spawnSession(id);
    if (this.logsEnabled !== false) tuiLogger.info(`[lane.spawned] ${JSON.stringify({ id, name, model })}`);
    this.emit('tmux:update');
  }

  /**
   * addBrowserPane — opens a carbonyl (Chromium-in-terminal) session as a
   * tracked lane. Carbonyl renders a real browser headlessly inside the pane,
   * streamed through the multiplexer like any other session.
   */
  addBrowserPane(url: string = 'https://localhost:3001'): void {
    const id = (this.tmuxSessions.length + 1).toString();
    // Round R4 (review M4): a link that carries a secret (the live board's token) is typed as a private launch
    // page, so the token is in neither send-keys' arguments, the pane shell's history, nor this lane's name or log.
    let page: string | null = url;
    if (carriesSecret(url)) { try { page = writeLaunchPage(url).href; } catch { page = null; } }
    const shown = shownAddress(url);
    const word = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
    this.tmuxSessions.push({ id, name: `Browser: ${shown}`, model: 'carbonyl/chromium-109' });
    this.tmuxMgr.spawnSession(id);
    this.tmuxMgr.sendCommand(id, page === null
      ? `printf '[Browser] Not opened: the private page that keeps the token of this link off command lines could not be written.\\n'`
      : `if command -v carbonyl >/dev/null 2>&1; then carbonyl ${word(page)}; else printf '\\033[31m[Browser]\\033[0m carbonyl not found on PATH. Install from https://github.com/fathyb/carbonyl\\n'; fi`, true);
    if (this.logsEnabled !== false) tuiLogger.info(`[browser.spawned] ${JSON.stringify({ id, url: shown })}`);
    this.emit('tmux:update');
  }

  removeTmuxSession(id: string): void {
    this.lastBlockedCommands.delete(id);
    this.tmuxMgr.killSession(id);
    this.tmuxSessions = this.tmuxSessions.filter(s => s.id !== id);
    if (this.logsEnabled !== false) tuiLogger.info(`[lane.removed] ${JSON.stringify({ id })}`);
    this.emit('tmux:update');
  }

  switchPaneAgent(id: string, agentKey: string): void {
    const session = this.tmuxSessions.find(s => s.id === id);
    if (!session) return;

    // R11 Phase 2 (H169, item b): a pane's agent label names no model (nothing here runs one); the OpenRouter pane's label is
    // the chosen model, or none
    const agentsMap: Record<string, { name: string; model: string }> = {
      opencode: { name: 'OpenCode CLI', model: '' },
      hermes: { name: 'Hermes CLI', model: '' },
      pi: { name: 'Pi Daemon', model: '' },
      jcode: { name: 'jcode', model: '' },
      minds: { name: 'Minds CLI', model: '' },
      openrouter: { name: 'OpenRouter Agent', model: this.config.model || '' }
    };

    const selected = agentsMap[agentKey];
    if (!selected) return;

    session.name = selected.name;
    session.model = selected.model;

    this.tmuxMgr.killSession(id);
    this.tmuxMgr.spawnSession(id);

    this.emit('tmux:update');
  }

  updateApiKey(apiKey: string): void {
    this.config.apiKey = apiKey;
    this.client = new OpenRouter({ apiKey });
  }

  addTool(t: ReturnType<typeof tool>): void {
    this.tools.push(t);
  }

  setTools(tools: ReturnType<typeof tool>[]): void {
    this.tools = tools;
  }

  setInstructions(instructions: string): void {
    this.config.instructions = instructions;
  }

  /**
   * R4 (H103): the chat's local route (src/agent/local-chat.ts): while one is set, every turn is answered by that Ollama and
   * model, never by OpenRouter or another model; null (the default) is the OpenRouter route, as before.
   */
  private localChat: (LocalChatRoute & { numCtx?: number }) | null = null;
  /** R10 (H169): the route policy, read at every turn (default: the settings', src/agent/route-policy.ts routePolicyNow) */
  private routePolicy: () => RoutePolicy = () => routePolicyNow();

  /** R10 (H169): where this agent reads the route policy (a test's, or a surface's own); null: the settings' again. */
  setRoutePolicy(read: (() => RoutePolicy) | null): void {
    this.routePolicy = read ?? (() => routePolicyNow());
  }
  /** R4 (H103): what the last turn on the local route reported (null: none yet, or it did not finish). */
  private lastLocal: LocalTurnResult | null = null;

  useLocalChat(route: (LocalChatRoute & { numCtx?: number }) | null): void {
    this.localChat = route ? { ...route } : null;
  }

  localChatRoute(): (LocalChatRoute & { numCtx?: number }) | null {
    return this.localChat ? { ...this.localChat } : null;
  }

  lastLocalTurn(): LocalTurnResult | null {
    return this.lastLocal;
  }

  /** R4 (H103): the OpenRouter route's model, whichever route answers the chat (/observe and describe_image ask OpenRouter). */
  openRouterModel(): string {
    return this.config.model;
  }

  getModel(): string {
    return this.localChat ? this.localChat.model : this.config.model;
  }

  setModel(model: string): void {
    // R4 (H103): on the local route the model is the local one (the REPL's /model checks it against Ollama's list first)
    if (this.localChat) {
      this.localChat = { ...this.localChat, model };
      this.logModelEvent('model.selected', { model, route: 'ollama' });
      this.emit('model:switch', model);
      return;
    }
    this.config.model = model;
    this.modelHealthStatus = 'UNTESTED';
    this.logModelEvent('model.selected', { model });
    this.emit('model:switch', model);
    this.emit('model:health', 'UNTESTED');
  }

  public logModelEvent(event: string, data: any) {
    try {
      const sanitizedData = { ...data };
      if (sanitizedData.apiKey) delete sanitizedData.apiKey;
      if (sanitizedData.Authorization) delete sanitizedData.Authorization;
      if (sanitizedData.env) delete sanitizedData.env;

      // writeLog adds the timestamp, honors the logs gate, and rotates at 200KB
      writeLog('agent-events.log', 'info', JSON.stringify({ event, ...sanitizedData }));
    } catch {}
  }

  /**
   * wireFileLogging — mirrors key lifecycle events into logs/timmy-tui.log so
   * the Logs panel reflects real activity (lane commands, approvals, runs,
   * receipts, model/mode switches) instead of staying frozen.
   */
  private wireFileLogging(): void {
    const summarize = (d: any): string => {
      try {
        const s = typeof d === 'string' ? d : JSON.stringify(d);
        return s && s.length > 160 ? s.slice(0, 157) + '...' : s;
      } catch {
        return String(d);
      }
    };
    const log = (event: string, data?: any) => {
      if (this.logsEnabled === false) return;
      tuiLogger.info(`[${event}]${data !== undefined ? ' ' + summarize(data) : ''}`);
    };

    this.on('tmux.command.sent' as any, (d: any) => log('lane.command.sent', {
      session: d?.sessionId,
      approved: d?.approved === true,
      cmd: String(d?.command || '').slice(0, 120)
    }));
    this.on('approval.required' as any, (d: any) => log('approval.required', { session: d?.sessionId, risk: d?.risk }));
    this.on('approval.granted' as any, (d: any) => log('approval.granted', { session: d?.sessionId }));
    this.on('command.finished' as any, (d: any) => log('lane.command.finished', { session: d?.sessionId, exitCode: d?.exitCode }));
    this.on('run.created' as any, (d: any) => log('run.created', { runId: d?.runId, source: d?.source }));
    this.on('receipt.generated' as any, (d: any) => log('receipt.generated', { receiptUrl: d?.receiptUrl }));
    this.on('model:switch' as any, (m: string) => log('model.switch', { model: m }));
    this.on('mode:change' as any, (m: string) => log('mode.change', { mode: m }));
  }

  async testModelHealth(modelId: string): Promise<{
    ok: boolean;
    error?: string;
    provider?: string;
    latency?: number;
  }> {
    const apiKey = this.config.apiKey;
    if (!apiKey) {
      // R4 (H87): no key, no request at all (never a placeholder key): the words say there is no model key
      const error = 'No model key, so nothing was sent: add one with `timmy init --tui` (or OPENROUTER_API_KEY)';
      this.modelHealthStatus = 'ERROR';
      this.lastHealthError = error;
      this.emit('model:health', 'ERROR');
      this.logModelEvent('model.test.failed', { modelId, error: 'no model key; nothing sent' });
      return { ok: false, error };
    }
    // R11 (H169, Phase 0 item 1): the check is a model call (one small request): never to a model nobody chose, and never to
    // one the route policy refuses. The order is the one route's (src/agent/chat-route.ts): local-only first (it refuses an
    // OpenRouter call whatever the model, chosen or not, so choosing one would not help), then no model chosen, then free-only
    // (which needs the chosen model's price)
    const policy = this.routePolicy();
    const refusedBy = (c: Exclude<ReturnType<typeof checkRoute>, { ok: true }>): { ok: false; error: string } => {
      this.lastHealthError = c.words;
      this.logModelEvent('model.test.failed', { modelId, error: `refused by the route policy (${c.reason}); nothing sent` });
      return { ok: false, error: c.words };
    };
    if (policy.localOnly) {
      const c = checkRoute({ source: 'openrouter', model: String(modelId ?? '').trim() || 'the chat\'s OpenRouter model', role: 'turn' }, policy);
      if (!c.ok) return refusedBy(c);
    }
    if (!String(modelId ?? '').trim()) {
      const error = 'No model chosen, so nothing was sent: choose a model first (/model <id> in the REPL, Models (M) in timmy workbench)';
      this.lastHealthError = error;
      this.logModelEvent('model.test.failed', { modelId, error: 'no model chosen; nothing sent' });
      return { ok: false, error };
    }
    if (policy.freeOnly) {
      const c = checkRoute({ source: 'openrouter', model: modelId, role: 'turn' }, policy);
      if (!c.ok) return refusedBy(c);
    }
    const start = Date.now();
    try {
      this.logModelEvent('model.test.started', { modelId });
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);
      
      // R4 (H87): OpenRouter, or a test's FAKE on 127.0.0.1 (TIMMY_MODEL_CHECK_URL, src/agent/model-check.ts)
      const response = await fetch(modelCheckUrl(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://github.com/woodman33/timmy-tui',
          'X-Title': 'TIMMYTUI'
        },
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: 'user', content: 'Reply OK.' }],
          // Meta's provider enforces max_output_tokens >= 16; 5 used to 400
          max_tokens: 16
        }),
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      const latency = Date.now() - start;
      if (!response.ok) {
        let errMsg = `HTTP ${response.status}`;
        try {
          const errData = await response.json();
          if (errData && errData.error && errData.error.message) {
            errMsg = errData.error.message;
          }
        } catch {}
        this.modelHealthStatus = 'ERROR';
        this.lastHealthError = errMsg;
        this.emit('model:health', 'ERROR');
        this.logModelEvent('model.test.failed', { modelId, error: errMsg });
        return { ok: false, error: errMsg, latency };
      }

      const resData = await response.json();
      const provider = resData?.provider || 'unknown';
      this.modelHealthStatus = 'READY';
      this.activeProvider = 'openrouter';
      this.lastHealthError = undefined;
      this.emit('model:health', 'READY');
      this.logModelEvent('model.test.succeeded', { modelId, latency, provider });
      return { ok: true, provider, latency };
    } catch (e: any) {
      const latency = Date.now() - start;
      const errMsg = e.name === 'AbortError' ? 'Request timed out after 8 seconds' : e.message;
      this.lastHealthError = errMsg;
      this.logModelEvent('model.test.failed', { modelId, error: errMsg });

      // Last resort: local Ollama keeps TIMMY talking when OpenRouter is down
      const probe = await probeOllama();
      if (probe.ok) {
        this.modelHealthStatus = 'FALLBACK READY';
        this.activeProvider = 'ollama';
        this.emit('model:health', 'FALLBACK READY');
        this.logModelEvent('model.test.fallback', { modelId, provider: 'ollama', models: probe.models.slice(0, 5) });
        return { ok: true, error: `OpenRouter failed (${errMsg}); Ollama fallback ready`, latency };
      }

      this.modelHealthStatus = 'ERROR';
      this.activeProvider = 'none';
      this.emit('model:health', 'ERROR');
      return { ok: false, error: errMsg, latency };
    }
  }

  // R4 (H87): no start-up check. runStartupHealthCheck (called on every mount of an agent in the monitor) is gone: a
  // monitor that starts asks nothing of a model and its provider status says "not checked"; testModelHealth above is the
  // explicit check, one small request, when the operator asks for it (`/model test`).

  /** R4 (H87): whether this agent has a model key (with none, nothing is sent to a model by a check). */
  public hasModelKey(): boolean {
    return Boolean(this.config.apiKey);
  }

  /** R4 (H103, D1c): what the last turn's last-resort fallback was, when it answered (null: it did not answer that turn). */
  private lastResort: LastResortAnswer | null = null;
  /** R10 (H169): the model OpenRouter named in its answers of the last turn (a response's `model`), when it named one */
  private lastReturned: string | null = null;
  /** R10 (H169): the model id the last turn's answer came from (the one asked, a fallback, or ollama/<model>), when it answered */
  private lastUsed: string | null = null;

  /** R10 (H169): the model the provider named in the last turn's answer (OpenRouter's response `model`), else null. */
  lastReturnedModel(): string | null {
    return this.lastReturned;
  }

  /** R10 (H169): the model id the last turn's answer came from, whatever was chosen since; null when it did not answer. */
  lastTurnModel(): string | null {
    return this.lastUsed;
  }

  /** R4 (H103, D1c): the last turn was answered by the last-resort fallback: which local model, where, and why (else null). */
  lastFallback(): LastResortAnswer | null {
    return this.lastResort ? { ...this.lastResort } : null;
  }

  /**
   * tryOllamaLastResort — when every OpenRouter candidate fails (with a key: without one, send refuses before any request),
   * answer via this computer's Ollama instead of throwing. Returns null if Ollama is unreachable or lists no local model.
   * R4 (H103, D1c): only a model with local weights on a loopback Ollama (pickOllamaModel and assertLocalOllamaModel refuse
   * cloud-backed ones); its answer is said where the person reads it, before the answer, in the words "OpenRouter failed:
   * <cause>; answered by local <model> on this computer's Ollama, the last-resort fallback" (the REPL's transcript and the
   * monitor show that notice), its text as a message item (the REPL shows text from those), no charge on that local endpoint,
   * and lastFallback() says it for the turn's receipt.
   */
  private async tryOllamaLastResort(
    history: { role: string; content: string }[],
    reason: string,
    policy: RoutePolicy | null = null,
  ): Promise<{ fullText: string; actualModel: string } | null> {
    try {
      const probe = await probeOllama();
      if (!probe.ok) return null;
      const model = pickOllamaModel(probe.models, ['granite', 'ornith', 'gemma', 'qwen']);
      if (!model) return null;
      // R10 (H169): the last-resort answer is a model call like any other: the route policy checks it (a loopback Ollama's
      // local weights pass both rules; anything else is not tried)
      if (policy && !checkRoute({ source: 'ollama-local', model, host: probe.base, role: 'last-resort' }, policy).ok) return null;
      this.logModelEvent('model.fallback.used', { provider: 'ollama', model, reason: String(reason).slice(0, 200) });
      this.emit('stream:start');
      const text = await ollamaChatCompletion(model, history);
      if (!text) return null;
      const cause = oneLine(redactString(String(reason)), 240);
      let host = probe.base ?? '';
      try { host = new URL(getLocalOllamaBaseUrl(probe.base)).host; } catch { /* the probe's own words */ }
      this.lastResort = { model, host, cause };
      this.emit('message:user', {
        role: 'assistant',
        content: `⚙️ **[SYSTEM]** OpenRouter failed: ${cause}; answered by local ${model} on this computer's Ollama, the last-resort fallback.`,
        timestamp: Date.now(),
      });
      this.emit('item:update', { type: 'message', id: `last-resort-${Date.now().toString(36)}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] });
      this.emit('stream:delta', text, text);
      this.emit('cost:update', 0, 0, { complete: true, basis: 'local endpoint' });
      this.modelHealthStatus = 'FALLBACK READY';
      this.activeProvider = 'ollama';
      this.emit('model:health', 'FALLBACK READY');
      return { fullText: text, actualModel: `ollama/${model}` };
    } catch {
      return null;
    }
  }

  getHistory(): Message[] {
    return this.conversation.getHistory();
  }

  clearHistory(): void {
    this.conversation.clear();
  }

  /** The REPL's /new: a new conversation a person chose (kept as the project's newest until written; see ConversationManager). */
  startSession(): string {
    return this.conversation.startNew({ chosen: true });
  }

  /**
   * R4 lead: the conversation this agent keeps (its folder, the one it holds, the ones on disk, and loading one), for the
   * project's one conversation across surfaces (src/agent/chat-turn.ts continueConversation). Reading and loading only.
   */
  keptConversation(): Pick<ConversationManager, 'directory' | 'current' | 'chosen' | 'listSessions' | 'load' | 'getHistory'> {
    return this.conversation;
  }

  /**
   * R1 workspace direction: keep the conversation in another folder (the active project's .sessions), so
   * each project carries its own context. Its latest conversation is resumed, else a new one starts.
   */
  useSessions(dir: string): { resumed: boolean; messages: number } {
    this.conversation = new ConversationManager(dir);
    const sessions = this.conversation.listSessions();
    if (sessions.length > 0) {
      try {
        return { resumed: true, messages: this.conversation.load(sessions[0]).length };
      } catch { /* an unreadable file: a new conversation instead */ }
    }
    this.conversation.startNew();
    return { resumed: false, messages: 0 };
  }

  isRunning(): boolean {
    return this.running;
  }

  async send(content: string, opts: SendOptions = {}): Promise<string> {
    if (this.running) throw new Error('Agent is already processing a message');
    // R4 (H103, D1): off the local route with no model key, nothing is sent: refused before the conversation takes the
    // message and before any request (never OpenRouter with an empty key, never the last-resort fallback). Every surface's
    // own check comes first (the REPL's, the chat session's); this one holds for any caller that has none.
    if (!this.localChat && !this.config.apiKey) {
      const refused = new NoModelKeyError();
      this.emit('error', refused);
      throw refused;
    }
    // R10 (H169): the route policy, read once for the turn: the turn's own request first, refused before the conversation
    // takes the message and before any request (every surface's own check comes first; this one holds for any caller)
    const policy = this.routePolicy();
    const guarded = policy.freeOnly || policy.localOnly;
    // R11 (H169, Phase 0 item 2): local-only refuses an OpenRouter turn whatever the model, chosen or not, so it is said before
    // "no model chosen" (choosing one would not help); the one route says them in the same order (src/agent/chat-route.ts)
    if (!this.localChat && policy.localOnly) {
      const own = checkRoute({ source: 'openrouter', model: String(this.config.model ?? '').trim() || 'the chat\'s OpenRouter model', role: 'turn' }, policy);
      if (!own.ok) {
        const refused = new PolicyRefusedError(own.reason, own.words);
        this.emit('error', refused);
        throw refused;
      }
    }
    // R11 (H169, Phase 0 item 1): a key and no chosen model: refused the same way (no default is ever taken in its place)
    if (!this.localChat && !String(this.config.model ?? '').trim()) {
      const refused = new NoModelChosenError();
      this.emit('error', refused);
      throw refused;
    }
    if (guarded) {
      const own = this.localChat
        ? checkRoute({ source: 'ollama-local', model: this.localChat.model, host: this.localChat.host, role: 'turn' }, policy)
        : checkRoute({ source: 'openrouter', model: this.config.model, role: 'turn' }, policy);
      if (!own.ok) {
        const refused = new PolicyRefusedError(own.reason, own.words);
        this.emit('error', refused);
        throw refused;
      }
    }
    // the tools a turn offers: each that asks a model of its own is checked at its call (policy off: the tools as set)
    const turnTools = guarded ? policyTools(this.tools, () => this.routePolicy(), { openRouterModel: () => this.config.model }) : this.tools;
    this.running = true;
    this.lastResort = null;
    this.lastReturned = null;
    this.lastUsed = null;
    // Additive options (inline REPL): a signal cancels the turn; retry asks the SDK to retry 429/5xx.
    const requestOptions = opts.signal || opts.retry
      ? {
          ...(opts.signal ? { signal: opts.signal } : {}),
          ...(opts.retry
            ? {
                retries: { strategy: 'backoff' as const, backoff: { initialInterval: 1000, maxInterval: 30000, exponent: 2, maxElapsedTime: 7500 }, retryConnectionErrors: true },
                retryCodes: ['429', '5XX'],
              }
            : {}),
        }
      : undefined;
    const aborted = (): boolean => opts.signal?.aborted === true;
    const cancelled = (): Error => Object.assign(new Error('Cancelled.'), { name: 'AbortError' });

    const userMessage: Message = { role: 'user', content, timestamp: Date.now() };
    try {
      // A request the conversation holds without an answer (a quit mid-turn, a crash, a failed request) is
      // closed before the next one, so the model never reads two pending requests and finishes the first.
      if (this.conversation.getHistory().at(-1)?.role === 'user') {
        this.conversation.appendMessage({ role: 'assistant', content: UNANSWERED, timestamp: Date.now() });
      }
      this.conversation.appendMessage(userMessage);
    } catch (err) {
      this.running = false;
      throw err;
    }
    this.emit('message:user', userMessage);
    this.emit('thinking:start');

    // What this request did, as the user saw it: each tool call with its result once that arrived, and
    // the text streamed so far. A cancel closes the request in the conversation with this record, so an
    // unrelated next turn does not resume it, and an explicit request to continue still can.
    const calls = new Map<string, ToolCallRecord>();
    let streamed = '';

    try {
      const history = this.conversation.getHistory().map(m => ({
        role: m.role as 'user' | 'assistant' | 'system',
        content: m.content,
      }));

      // R4 (H103): the local route: the Ollama the setup recorded answers (src/agent/local-chat.ts), with the same tools and
      // gates; never OpenRouter, never another model. A cancel leaves the same record as below (its calls and text).
      if (this.localChat) {
        this.lastLocal = null;
        const local = await runLocalTurn({
          route: this.localChat, instructions: this.config.instructions, history, tools: turnTools,
          maxSteps: this.config.maxSteps || 10, signal: opts.signal, ...(this.localChat.numCtx ? { numCtx: this.localChat.numCtx } : {}),
          hooks: {
            emit: (event, ...args) => void (this.emit as (e: string, ...a: unknown[]) => boolean)(event, ...args),
            call: (id, name, args) => void calls.set(id, { name, args }),
            output: (id, name, output, late) => {
              const seen = calls.get(id);
              if (seen) Object.assign(seen, { output, late });
              else calls.set(id, { name, args: '', output, late });
            },
            text: (full) => { streamed = full; },
          },
        });
        this.lastLocal = local;
        this.lastUsed = local.actualModel || this.localChat.model;
        this.activeProvider = 'ollama';
        this.emit('stream:end', local.fullText);
        const answer: Message = { role: 'assistant', content: local.fullText, timestamp: Date.now() };
        this.conversation.appendMessage(answer);
        this.emit('message:assistant', answer);
        return local.fullText;
      }

      const runCompletionWithModel = async (modelId: string, isFallback = false) => {
        const result = this.client.callModel({
          model: modelId,
          instructions: this.config.instructions,
          input: history as any,
          tools: turnTools.length > 0 ? turnTools : undefined,
          stopWhen: [
            stepCountIs(this.config.maxSteps || 10),
            maxCost(this.config.maxCost || 1),
          ],
          ...(this.config.temperature !== undefined ? { temperature: this.config.temperature } : {}),
          // clamp: some providers (Meta) reject maxOutputTokens < 16
          ...(this.config.maxOutputTokens ? { maxOutputTokens: Math.max(16, this.config.maxOutputTokens) } : {}),
        }, requestOptions);

        // What this request cost is what OpenRouter charged: the `cost` its usage reports on every
        // response of the tool loop, each counted once by its id (LIVE-01, ledger row 65: a flat
        // $0.00001 a token on the last response only, and nothing for a cancel). The responses arrive
        // on the full stream as they complete, so a cancel still knows what was charged before it.
        const charged = new Map<string, number>();
        const unreported = new Set<string>();
        const money = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
        const price = (response: any): void => {
          if (!response || typeof response !== 'object') return;
          // R10 (H169): the model OpenRouter says answered (its response's `model`), apart from the one asked
          if (typeof response.model === 'string' && response.model) this.lastReturned = response.model.slice(0, 200);
          const key = typeof response.id === 'string' && response.id ? response.id : `response-${charged.size + unreported.size}`;
          const usage = response.usage ?? {};
          // On the operator's own provider key (BYOK), `cost` is only OpenRouter's fee and the provider
          // bills its own charge, `upstreamInferenceCost`; without BYOK that charge is inside `cost`.
          const byok = usage.isByok ?? usage.is_byok;
          const upstream = usage.costDetails?.upstreamInferenceCost ?? usage.cost_details?.upstream_inference_cost;
          const cost = money(usage.cost) && (byok !== true || money(upstream)) ? usage.cost + (byok === true ? upstream : 0) : undefined;
          if (cost !== undefined) {
            charged.set(key, cost);
            unreported.delete(key);
          } else if (!charged.has(key)) {
            // What is known still counts, as a lower bound.
            if (money(usage.cost)) charged.set(key, usage.cost);
            unreported.add(key);
          }
        };
        const collector: Promise<void> = typeof (result as any).getFullResponsesStream === 'function'
          ? (async () => {
              try {
                for await (const event of (result as any).getFullResponsesStream() as AsyncIterable<any>) {
                  if (event?.type === 'response.completed' || event?.type === 'response.incomplete') price(event.response);
                }
              } catch {
                // The items stream reports the failure; the charges seen so far still count.
              }
            })()
          : Promise.resolve();
        let costSent = false;
        const sendCost = (complete: boolean): void => {
          if (costSent) return;
          costSent = true;
          const total = [...charged.values()].reduce((sum, c) => sum + c, 0);
          this.emit('cost:update', total, total, { complete: complete && unreported.size === 0 && charged.size > 0 });
        };

        this.emit('stream:start');
        let fullText = '';
        const textByItem = new Map<string, number>();
        const callNames = new Map<string, string>();

        // On cancel, stop the stream and keep draining the SDK's generator to its end: leaving it early
        // would strand its background execution promise, which then rejects unhandled.
        let draining = false;
        const onAbort = (): void => {
          draining = true;
          void Promise.resolve(result.cancel?.()).catch(() => {});
        };
        if (opts.signal) opts.signal.addEventListener('abort', onAbort, { once: true });
        // A tool's result, kept for the record a cancel leaves. `late`: it arrived while the cancel took hold
        // (the SDK finishes a round of tool calls it has started); it is a real effect, never shown.
        const noteOutput = (item: any, late: boolean): string => {
          const out = typeof item.output === 'string' ? item.output : JSON.stringify(item.output);
          const name = callNames.get(item.callId || '') || 'unknown';
          const seen = calls.get(item.callId || '');
          if (seen) Object.assign(seen, { output: out, late });
          else calls.set(item.callId || `call-${calls.size}`, { name, args: '', output: out, late });
          return out;
        };
        try {
        for await (const item of result.getItemsStream() as AsyncIterable<StreamableOutputItem>) {
          if (draining || aborted()) {
            if (!draining) onAbort();
            if (item.type === 'function_call_output') noteOutput(item, true);
            continue;
          }
          this.emit('item:update', item);

          if (item.type === 'message') {
            const text = (item as any).content
              ?.filter((c: any) => 'text' in c)
              .map((c: any) => c.text)
              .join('') ?? '';
            const prev = textByItem.get((item as any).id || '') ?? 0;
            if (text.length > prev) {
              const delta = text.slice(prev);
              fullText += delta;
              streamed = fullText;
              this.emit('stream:delta', delta, fullText);
              textByItem.set((item as any).id || '', text.length);
            }
          } else if (item.type === 'function_call') {
            callNames.set((item as any).callId || '', (item as any).name || '');
            if ((item as any).status === 'completed') {
              let args = {};
              try {
                args = JSON.parse((item as any).arguments || '{}');
              } catch { }
              calls.set((item as any).callId || `call-${calls.size}`, { name: (item as any).name || '', args: (item as any).arguments || '{}' });
              this.emit('tool:call', (item as any).name || '', args);
            }
          } else if (item.type === 'function_call_output') {
            const out = noteOutput(item, false);
            this.emit('tool:result', callNames.get((item as any).callId || '') || 'unknown', out);
          } else if (item.type === 'reasoning') {
            const text = (item as any).summary?.map((s: any) => s.text).join('') ?? '';
            if (text) this.emit('reasoning:update', text);
          }
        }
        } catch (err) {
          // What was charged before a cancel or a failure still counts, as a lower bound.
          sendCost(false);
          if (aborted()) throw cancelled();
          throw err;
        } finally {
          opts.signal?.removeEventListener('abort', onAbort);
        }
        if (aborted()) {
          sendCost(false);
          throw cancelled();
        }

        let final: any;
        try {
          final = await result.getResponse();
        } catch { }
        if (final) {
          price(final);
          if (!fullText && final.outputText) fullText = final.outputText;
        }
        // The full stream ends with the items stream; never wait on it for long.
        await Promise.race([collector, new Promise<void>((done) => { setTimeout(done, 1000).unref?.(); })]);
        sendCost(final !== undefined);

        this.modelHealthStatus = isFallback ? 'FALLBACK READY' : 'READY';
        this.activeProvider = 'openrouter';
        this.emit('model:health', this.modelHealthStatus);
        return { fullText, actualModel: modelId };
      };

      let activeModel = this.config.model;
      let executionResult: { fullText: string; actualModel: string };

      try {
        executionResult = await runCompletionWithModel(activeModel, false);
        if (aborted()) throw cancelled();
      } catch (err: any) {
        // A cancelled turn tries no fallback model.
        if (aborted() || err?.name === 'AbortError') throw cancelled();
        this.modelHealthStatus = 'ERROR';
        this.emit('model:health', 'ERROR');
        const sanitizedErr = err.message || 'Unknown provider error';
        this.logModelEvent('openrouter.request.failed', { model: activeModel, error: sanitizedErr });
        // R11 (H169, Phase 0 item 1; the lead's rule of 2026-10-23 09:04, from the operator's order: never a paid model in
        // place of one the person chose): no paid fallback model is ever tried (the shipped FALLBACK_ORDER is gone). A fallback
        // is taken only under free-only or local-only, to the local model on this computer's Ollama that the policy allows
        // (R4 H103 D1c's last resort, said beside its answer and named in the receipt); with the policy off the turn ends with
        // the reason and the next step, and nothing else is asked.
        const ollamaResult = guarded ? await this.tryOllamaLastResort(history, `${activeModel}: ${oneLine(sanitizedErr, 160)}`, policy) : null;
        if (ollamaResult) {
          executionResult = ollamaResult;
        } else {
          const finalErr = `OpenRouter request failed for ${activeModel}.\nReason: ${sanitizedErr}.\nNext: choose another model (Models (M) in timmy workbench, or /model <id> in the REPL) or try again. No fallback model was tried${guarded ? ' on OpenRouter, and no local model on this computer could answer' : ': a model nobody chose is never asked in its place'}.`;
          const error = new Error(finalErr);
          this.emit('error', error);
          throw error;
        }
      }

      this.emit('stream:end', executionResult.fullText);
      this.lastUsed = executionResult.actualModel;

      const assistantMessage: Message = { role: 'assistant', content: executionResult.fullText, timestamp: Date.now() };
      this.conversation.appendMessage(assistantMessage);
      this.emit('message:assistant', assistantMessage);

      return executionResult.fullText;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (error.name !== 'AbortError') this.emit('error', error);
      else this.conversation.appendMessage({ role: 'assistant', content: cancelRecord([...calls.values()], streamed), timestamp: Date.now() });
      throw error;
    } finally {
      this.emit('thinking:end');
      this.running = false;
    }
  }
}

/** One tool call of a request, as the record of a cancel keeps it. */
interface ToolCallRecord { name: string; args: string; output?: string; late?: boolean }

/** What closes a request that was left without an answer: a quit mid-turn, a crash or a failed request. */
export const UNANSWERED = '[I did not answer this request: it was interrupted before I could (the program ended, or the request failed). I will not continue it unless the user asks me to.]';

/**
 * R5 lead (the QA round, defect 8): the records Timmy writes into the conversation in the assistant's voice, so the model
 * knows a request ended without its answer (cancelRecord, UNANSWERED). A surface shows one as Timmy's own note of the stop,
 * never under the model's speaker label, and does not repeat the partial answer it quotes (already shown as it streamed).
 */
export const isTimmyRecord = (text: string): boolean => text.startsWith('[Cancelled by the user before I') || text === UNANSWERED;

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text);
/** Tool data or streamed text as a quoted string, secrets redacted: it can neither speak as the assistant nor leave a key in the saved session. */
const quote = (text: string, max = 400): string => JSON.stringify(clip(redactString(text), max));
/** A call's arguments as compact JSON when they are JSON, else quoted like any other tool data. */
const argsText = (raw: string): string => {
  try {
    const compact = JSON.stringify(JSON.parse(redactString(raw)));
    if (compact.length <= 400) return compact;
  } catch { /* not JSON */ }
  return quote(raw);
};

/**
 * The record that closes a cancelled request in the conversation, in the assistant's voice: what finished
 * before the cancel, with its result; what finished while the cancel took hold; what started with no result,
 * whose effect is unknown; the text streamed so far; and that the request continues only if the user asks.
 * Tool data and text are quoted and redacted. Without the record the conversation ended in the cancelled
 * request, and the next turn, about anything, finished it too (LIVE-01 at C-17).
 */
export function cancelRecord(calls: ToolCallRecord[], streamed: string): string {
  // R5 lead (the QA round, defect 8): "before I answered" only when nothing was written or run; a partial answer is quoted below
  const parts = [streamed.trim() || calls.some((c) => c.output !== undefined) ? '[Cancelled by the user before I finished answering.' : '[Cancelled by the user before I answered.'];
  const label = (c: ToolCallRecord): string => (c.args ? `${c.name} ${argsText(c.args)}` : c.name);
  const returned = (c: ToolCallRecord): string => `${label(c)}, which returned ${quote(c.output ?? '')}`;
  const finished = calls.filter((c) => c.output !== undefined && !c.late);
  const late = calls.filter((c) => c.output !== undefined && c.late);
  const started = calls.filter((c) => c.output === undefined);
  if (calls.length === 0) parts.push('No tool had run.');
  if (finished.length) parts.push(`Finished before the cancel: ${finished.map(returned).join('; ')}.`);
  if (late.length) parts.push(`Finished after the cancel was requested: ${late.map(returned).join('; ')}.`);
  if (started.length) parts.push(`Started, with no result, so its effect is unknown: ${started.map(label).join('; ')}.`);
  if (streamed.trim()) parts.push(`What I had written so far: ${quote(streamed.trim(), 1200)}.`);
  if (calls.length) parts.push('Nothing was rolled back.');
  parts.push('I stopped here and will not continue this request unless the user asks me to.]');
  return parts.join(' ');
}

export function createAgent(config: AgentConfig, options: AgentOptions = {}): Agent {
  return new Agent(config, options);
}
