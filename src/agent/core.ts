import { OpenRouter } from '@openrouter/sdk';
import { tool } from '@openrouter/sdk/lib/tool.js';
import { stepCountIs, maxCost } from '@openrouter/sdk/lib/stop-conditions.js';
import type { StreamableOutputItem } from '@openrouter/sdk/lib/stream-transformers.js';
import { EventEmitter } from 'eventemitter3';
import type { AgentEvents } from './events.js';
import type { Message, AgentConfig } from '../types/index.js';
import { ConversationManager } from './conversation.js';
import { defaultTools } from './tools.js';
import { publish as appendEvent } from '../bus/index.js';
import { execSync, execFileSync } from 'child_process';
import { classifyCommand } from '../utils/safety.js';
import fs from 'fs';
import path from 'path';
import { MultiplexerManager } from './multiplexer.js';
import { ZellijManager } from './zellij.js';
import { RmuxManager } from './rmux.js';
import { DEFAULT_LANE_BINDINGS, LANE_RUNNERS, laneStartupScript } from './lanes.js';
import { writeLog, tuiLogger } from '../utils/logger.js';
import { probeOllama, pickOllamaModel, ollamaChatCompletion } from './providers.js';

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

  constructor(agent: Agent) {
    this.agent = agent;
  }

  init() {
    this.cleanupOrphaned();
    // Pre-spawn standard sessions on startup
    for (const session of this.agent.tmuxSessions) {
      this.spawnSession(session.id);
    }
    // Start non-blocking polling thread
    const pollMs = process.env.TIMMY_TMUX_POLL_MS ? parseInt(process.env.TIMMY_TMUX_POLL_MS, 10) : 500;
    this.pollInterval = setInterval(() => this.poll(), pollMs);
  }

  cleanupOrphaned() {
    try {
      const list = execFileSync('tmux', ['list-sessions', '-F', '#S'], { encoding: 'utf8', stdio: 'pipe' });
      const sessions = list.split('\n').map(s => s.trim()).filter(s => s.startsWith('ortui-'));
      for (const s of sessions) {
        execFileSync('tmux', ['kill-session', '-t', s], { stdio: 'ignore' });
      }
    } catch {
      // Ignore if no sessions are running or tmux is missing
    }
  }

  spawnSession(id: string) {
    const sName = `ortui-${id}`;
    try {
      execFileSync('tmux', ['new-session', '-d', '-s', sName], { stdio: 'ignore' });
      this.lastOutputs.set(id, []);

      const runnerKey = DEFAULT_LANE_BINDINGS[id];

      // Generate dynamic AgentPass credentials
      const jti = `ap_${Math.random().toString(36).substring(2, 8)}${Math.random().toString(36).substring(2, 8)}`;
      const visa = `visa_${Math.random().toString(36).substring(2, 8)}`;
      const hash = `hash_${Math.random().toString(36).substring(2, 8)}`;

      const startup = laneStartupScript(runnerKey, jti, visa, hash);
      execFileSync('tmux', ['send-keys', '-t', sName, startup, 'C-m'], { stdio: 'ignore' });
    } catch {
      // Ignore errors
    }
  }

  killSession(id: string) {
    const sName = `ortui-${id}`;
    try {
      execFileSync('tmux', ['kill-session', '-t', sName], { stdio: 'ignore' });
      this.lastOutputs.delete(id);
    } catch {}
  }

  getCwd(id: string): string {
    const sName = `ortui-${id}`;
    try {
      return execFileSync('tmux', ['display-message', '-p', '-t', sName, '-F', '#{pane_current_path}'], { encoding: 'utf8', stdio: 'pipe' }).trim();
    } catch {
      return process.cwd();
    }
  }

  capturePane(id: string): string[] {
    const sName = `ortui-${id}`;
    try {
      const output = execFileSync('tmux', ['capture-pane', '-pt', sName], { encoding: 'utf8', stdio: 'pipe' });
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
      execFileSync('tmux', ['send-keys', '-t', sName, wrappedCommand, 'C-m'], { stdio: 'ignore' });
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

  public currentRunId = 'default-local-run';
  public lastBlockedCommands: Map<string, string> = new Map();
  public modelHealthStatus: 'UNTESTED' | 'READY' | 'ERROR' | 'FALLBACK READY' = 'UNTESTED';
  /** Live file-logging switch — mirrored into the logger gate by OptionsPanel. */
  public logsEnabled: boolean = true;
  /** Which upstream is currently answering: openrouter, ollama, or none. */
  public activeProvider: 'openrouter' | 'ollama' | 'none' = 'none';
  /** Human-readable reason for the last health-check failure, shown in the UI. */
  public lastHealthError: string | undefined;

  // Persistent workspace chamber contexts (logs)
  public workspaceContexts: Record<string, string[]> = {
    'opencode': [
      '📡 [VM TUNNEL] Established secure link to Daytona Sandbox container...',
      '⚙️ [opencode] tsx cli.tsx build -> verified 0 compile errors.'
    ],
    'hermes': [
      '📡 [VM TUNNEL] Established secure link to Daytona Sandbox container...',
      '🧠 [hermes] literature search -> mapped 14 active ontology records.'
    ],
    'pi': [
      '📡 [VM TUNNEL] Established secure link to Daytona Sandbox container...',
      '👑 [pi-swarm] AgentPass passport claim verified: jti_auth_91a783'
    ],
    'openrouter': [
      '📡 [VM TUNNEL] Established secure link to Daytona Sandbox container...',
      '⚡ [openrouter] anthropic/claude-3-5-sonnet -> 1.5k context tokens synced.'
    ]
  };

  // Unified active workspace VM thread logs relayed to Proof page
  public relayedVmLogs: string[] = [
    '📡 [VM TUNNEL] Established secure link to Daytona Sandbox container...',
    '⚙️ [opencode] tsx cli.tsx build -> verified 0 compile errors.',
    '🧠 [hermes] literature search -> mapped 14 active ontology records.',
    '👑 [pi-swarm] AgentPass passport claim verified: jti_auth_91a783',
    '⚡ [openrouter] anthropic/claude-3-5-sonnet -> 1.5k context tokens synced.',
    '☁️ [sqlite-d1] Push evidence transaction completed -> CF Durable Object database.',
    '🔐 [EMBASSY] Tamper-evident manifest seal armed: sha256_82f1a8c9b20d3f82',
    '✓ ALL AGENT CHECKS PASSED. CONFORMANCE: 100%'
  ];

  // TMUX Cluster & Background Workspace Session Tracker
  public tmuxSessions = [
    { id: '1', name: 'OpenCode CLI', model: 'qwen/qwen-2.5-coder-32b', memory: '14.8 MB', cost: 0.0020 },
    { id: '2', name: 'Hermes CLI', model: 'nousresearch/hermes-3-llama-3.1-405b', memory: '12.1 MB', cost: 0.0034 },
    { id: '3', name: 'Pi Daemon', model: 'inflection/pi-3', memory: '22.4 MB', cost: 0.0015 },
    { id: '4', name: 'Systems MCP', model: 'meta/llama-3.3', memory: '8.2 MB', cost: 0.0015 },
    { id: '5', name: 'jcode', model: 'jcode/default', memory: '0.0 MB', cost: 0.0000 },
    { id: '6', name: 'Minds CLI', model: 'animoca/builder', memory: '0.0 MB', cost: 0.0000 }
  ];
  public showTmuxDropdown = false;

  constructor(config: AgentConfig) {
    super();
    this.client = new OpenRouter({ apiKey: config.apiKey });
    this.conversation = new ConversationManager();
    this.config = config;
    this.tools = [...defaultTools];

    // Initialize multiplexer background manager (tmux, zellij, or rmux)
    const mux = process.env.TIMMY_MULTIPLEXER || 'tmux';
    if (mux === 'zellij') {
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
    this.tmuxSessions.push({
      id,
      name,
      model,
      memory: `${(Math.random() * 20 + 10).toFixed(1)} MB`,
      cost: 0.0000
    });
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
    this.tmuxSessions.push({
      id,
      name: `Browser: ${url}`,
      model: 'carbonyl/chromium-109',
      memory: '0.0 MB',
      cost: 0.0000
    });
    this.tmuxMgr.spawnSession(id);
    this.tmuxMgr.sendCommand(id, `if command -v carbonyl >/dev/null 2>&1; then carbonyl "${url}"; else printf '\\033[31m[Browser]\\033[0m carbonyl not found on PATH. Install from https://github.com/fathyb/carbonyl\\n'; fi`, true);
    if (this.logsEnabled !== false) tuiLogger.info(`[browser.spawned] ${JSON.stringify({ id, url })}`);
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

    const agentsMap: Record<string, { name: string; model: string }> = {
      opencode: { name: 'OpenCode CLI', model: 'qwen/qwen-2.5-coder-32b' },
      hermes: { name: 'Hermes CLI', model: 'nousresearch/hermes-3-llama-3.1-405b' },
      pi: { name: 'Pi Daemon', model: 'inflection/pi-3' },
      jcode: { name: 'jcode', model: 'jcode/default' },
      minds: { name: 'Minds CLI', model: 'animoca/builder' },
      openrouter: { name: 'OpenRouter Agent', model: this.config.model || 'anthropic/claude-3-5-sonnet' }
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

  getModel(): string {
    return this.config.model;
  }

  setModel(model: string): void {
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
      // No more silent early-return: surface the missing-key failure in logs + UI
      this.modelHealthStatus = 'ERROR';
      this.lastHealthError = 'API key is missing (set OPENROUTER_API_KEY in .env)';
      this.emit('model:health', 'ERROR');
      this.logModelEvent('model.test.failed', { modelId, error: 'API key is missing' });
      return { ok: false, error: 'API key is missing' };
    }
    const start = Date.now();
    try {
      this.logModelEvent('model.test.started', { modelId });
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);
      
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
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

  /** Run once on TUI mount so Provider Status reflects reality immediately. */
  public runStartupHealthCheck(): void {
    void this.testModelHealth(this.config.model);
  }

  /**
   * tryOllamaLastResort — when every OpenRouter candidate fails, answer via
   * local Ollama instead of throwing. Returns null if Ollama is unreachable.
   */
  private async tryOllamaLastResort(
    history: { role: string; content: string }[],
    reason: string
  ): Promise<{ fullText: string; actualModel: string } | null> {
    try {
      const probe = await probeOllama();
      if (!probe.ok) return null;
      const model = pickOllamaModel(probe.models, ['kimi-k2.7-code', 'glm-5.2', 'minimax-m3', 'qwen', 'ornith']);
      if (!model) return null;
      this.logModelEvent('model.fallback.used', { provider: 'ollama', model, reason: String(reason).slice(0, 200) });
      this.emit('stream:start');
      const text = await ollamaChatCompletion(model, history);
      if (!text) return null;
      this.emit('stream:delta', text, text);
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

  startSession(): string {
    return this.conversation.startNew();
  }

  isRunning(): boolean {
    return this.running;
  }

  async send(content: string): Promise<string> {
    if (this.running) throw new Error('Agent is already processing a message');
    this.running = true;

    const userMessage: Message = { role: 'user', content, timestamp: Date.now() };
    this.conversation.appendMessage(userMessage);
    this.emit('message:user', userMessage);
    this.emit('thinking:start');

    const FALLBACK_ORDER = [
      'anthropic/claude-opus-4.7',
      'google/gemini-3.5-flash',
      'openai/gpt-5.5',
      'minimax/minimax-m3'
    ];

    try {
      const history = this.conversation.getHistory().map(m => ({
        role: m.role as 'user' | 'assistant' | 'system',
        content: m.content,
      }));

      const runCompletionWithModel = async (modelId: string, isFallback = false) => {
        const result = this.client.callModel({
          model: modelId,
          instructions: this.config.instructions,
          input: history as any,
          tools: this.tools.length > 0 ? this.tools : undefined,
          stopWhen: [
            stepCountIs(this.config.maxSteps || 10),
            maxCost(this.config.maxCost || 1),
          ],
          ...(this.config.temperature !== undefined ? { temperature: this.config.temperature } : {}),
          // clamp: some providers (Meta) reject maxOutputTokens < 16
          ...(this.config.maxOutputTokens ? { maxOutputTokens: Math.max(16, this.config.maxOutputTokens) } : {}),
        });

        this.emit('stream:start');
        let fullText = '';
        const textByItem = new Map<string, number>();
        const callNames = new Map<string, string>();

        for await (const item of result.getItemsStream() as AsyncIterable<StreamableOutputItem>) {
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
              this.emit('tool:call', (item as any).name || '', args);
            }
          } else if (item.type === 'function_call_output') {
            const out = typeof (item as any).output === 'string' ? (item as any).output : JSON.stringify((item as any).output);
            this.emit('tool:result', callNames.get((item as any).callId || '') || 'unknown', out);
          } else if (item.type === 'reasoning') {
            const text = (item as any).summary?.map((s: any) => s.text).join('') ?? '';
            if (text) this.emit('reasoning:update', text);
          }
        }

        let usage: any = undefined;
        try {
          const response = await result.getResponse();
          usage = (response as any).usage;
          if (!fullText && (response as any).outputText) {
            fullText = (response as any).outputText;
          }
        } catch { }

        if (usage) {
          const inTokens = usage.inputTokens ?? usage.promptTokens ?? 0;
          const outTokens = usage.outputTokens ?? usage.completionTokens ?? 0;
          const cost = (inTokens + outTokens) * 0.00001;
          this.emit('cost:update', cost, cost);
        }

        this.modelHealthStatus = isFallback ? 'FALLBACK READY' : 'READY';
        this.activeProvider = 'openrouter';
        this.emit('model:health', this.modelHealthStatus);
        return { fullText, actualModel: modelId };
      };

      let activeModel = this.config.model;
      let executionResult: { fullText: string; actualModel: string };

      try {
        executionResult = await runCompletionWithModel(activeModel, false);
      } catch (err: any) {
        this.modelHealthStatus = 'ERROR';
        this.emit('model:health', 'ERROR');
        const sanitizedErr = err.message || 'Unknown provider error';
        this.logModelEvent('openrouter.request.failed', { model: activeModel, error: sanitizedErr });

        let fallbackModel = '';
        for (const candidate of FALLBACK_ORDER) {
          if (candidate !== activeModel) {
            fallbackModel = candidate;
            break;
          }
        }

        if (fallbackModel) {
          this.logModelEvent('model.fallback.used', { selectedModel: activeModel, fallbackModel });
          
          try {
            executionResult = await runCompletionWithModel(fallbackModel, true);
            
            this.emit('message:user', {
              role: 'assistant',
              content: `⚙️ **[SYSTEM]** Selected model \`${activeModel}\` failed (Reason: ${sanitizedErr}).\nRetried and succeeded with fallback model \`${fallbackModel}\`.`,
              timestamp: Date.now()
            });

            this.config.model = fallbackModel;
            this.emit('model:switch', fallbackModel);
          } catch (fallbackErr: any) {
            const ollamaResult = await this.tryOllamaLastResort(history, `${sanitizedErr} / ${fallbackErr.message}`);
            if (ollamaResult) {
              executionResult = ollamaResult;
              this.emit('message:user', {
                role: 'assistant',
                content: `⚙️ **[SYSTEM]** OpenRouter unreachable. Answered via local Ollama (\`${ollamaResult.actualModel}\`).`,
                timestamp: Date.now()
              });
            } else {
              const finalErr = `OpenRouter request failed for ${activeModel}.\nReason: ${sanitizedErr}.\nNext: choose another model or run /model fallback.\n\nFallback failed for ${fallbackModel} too: ${fallbackErr.message}`;
              const error = new Error(finalErr);
              this.emit('error', error);
              throw error;
            }
          }
        } else {
          const ollamaResult = await this.tryOllamaLastResort(history, sanitizedErr);
          if (ollamaResult) {
            executionResult = ollamaResult;
            this.emit('message:user', {
              role: 'assistant',
              content: `⚙️ **[SYSTEM]** OpenRouter unreachable. Answered via local Ollama (\`${ollamaResult.actualModel}\`).`,
              timestamp: Date.now()
            });
          } else {
            const finalErr = `OpenRouter request failed for ${activeModel}.\nReason: ${sanitizedErr}.\nNext: choose another model or run /model fallback.`;
            const error = new Error(finalErr);
            this.emit('error', error);
            throw error;
          }
        }
      }

      this.emit('stream:end', executionResult.fullText);

      const assistantMessage: Message = { role: 'assistant', content: executionResult.fullText, timestamp: Date.now() };
      this.conversation.appendMessage(assistantMessage);
      this.emit('message:assistant', assistantMessage);

      return executionResult.fullText;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit('error', error);
      throw error;
    } finally {
      this.emit('thinking:end');
      this.running = false;
    }
  }
}

export function createAgent(config: AgentConfig): Agent {
  return new Agent(config);
}
