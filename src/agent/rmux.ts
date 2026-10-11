import { execSync, execFileSync } from 'child_process';
import { MultiplexerManager } from './multiplexer.js';
import { classifyCommand } from '../utils/safety.js';
import type { Agent } from './core.js';
import { DEFAULT_LANE_BINDINGS, laneStartupScript } from './lanes.js';

/**
 * RmuxManager — drives rmux, a tmux-CLI-compatible multiplexer (v0.3.1+).
 *
 * rmux speaks the tmux command interface (new-session/send-keys/capture-pane/
 * kill-session), so this mirrors TmuxManager but targets the `rmux` binary.
 * Sessions persist on /private/tmp/rmux-<uid>/ sockets by default.
 */
export class RmuxManager implements MultiplexerManager {
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

  private readonly bin = process.env.TIMMY_RMUX_BIN || 'rmux';

  constructor(agent: Agent) {
    this.agent = agent;
  }

  init() {
    this.cleanupOrphaned();
    for (const session of this.agent.tmuxSessions) {
      this.spawnSession(session.id);
    }
    const pollMs = process.env.TIMMY_RMUX_POLL_MS ? parseInt(process.env.TIMMY_RMUX_POLL_MS, 10) : 500;
    this.pollInterval = setInterval(() => this.poll(), pollMs);
  }

  cleanupOrphaned() {
    try {
      const list = execFileSync(this.bin, ['list-sessions', '-F', '#S'], { encoding: 'utf8', stdio: 'pipe' });
      const sessions = list.split('\n').map(s => s.trim()).filter(s => s.startsWith('ortui-'));
      for (const s of sessions) {
        execFileSync(this.bin, ['kill-session', '-t', s], { stdio: 'ignore' });
      }
    } catch {
      // No server running or rmux missing — fine.
    }
  }

  spawnSession(id: string) {
    const sName = `ortui-${id}`;
    try {
      execFileSync(this.bin, ['new-session', '-d', '-s', sName], { stdio: 'ignore' });
      this.lastOutputs.set(id, []);

      const runnerKey = DEFAULT_LANE_BINDINGS[id];

      const startup = laneStartupScript(runnerKey);
      execFileSync(this.bin, ['send-keys', '-t', sName, startup, 'C-m'], { stdio: 'ignore' });
    } catch {
      // Ignore errors — capturePane fallback covers the UI state.
    }
  }

  killSession(id: string) {
    const sName = `ortui-${id}`;
    try {
      execFileSync(this.bin, ['kill-session', '-t', sName], { stdio: 'ignore' });
      this.lastOutputs.delete(id);
    } catch {}
  }

  getCwd(id: string): string {
    const sName = `ortui-${id}`;
    try {
      return execFileSync(this.bin, ['display-message', '-p', '-t', sName, '-F', '#{pane_current_path}'], { encoding: 'utf8', stdio: 'pipe' }).trim();
    } catch {
      return process.cwd();
    }
  }

  capturePane(id: string): string[] {
    const sName = `ortui-${id}`;
    try {
      const output = execFileSync(this.bin, ['capture-pane', '-pt', sName], { encoding: 'utf8', stdio: 'pipe' });
      const lines = output.split('\n');
      while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
        lines.pop();
      }
      return lines;
    } catch {
      return [`[System Error] Failed to capture output buffer from rmux session "${sName}"`];
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
        this.agent.lastBlockedCommands.delete(id);

        this.agent.emit('approval.granted' as any, {
          runId,
          sessionId: id,
          sessionName,
          command,
          timestamp: new Date().toISOString()
        });
      }

      const commandId = `cmd_${Math.random().toString(36).substring(2, 9)}`;
      const cwdBefore = this.getCwd(id);
      const startedAt = new Date().toISOString();
      const wrappedCommand = `( ${command} ); printf "\\nTIMMY_EXIT_CODE:${commandId}:%s\\n" "$?"`;

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

      execFileSync(this.bin, ['send-keys', '-t', sName, wrappedCommand, 'C-m'], { stdio: 'ignore' });
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
        continue;
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