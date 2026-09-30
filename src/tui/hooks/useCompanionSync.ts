import React, { useEffect } from 'react';
import type { Agent } from '../../agent/core.js';
import type { Message } from '../../types/index.js';

interface UseCompanionSyncProps {
  agent: Agent;
  messages: Message[];
  activeRunId?: string;
  activeReceiptUrl?: string;
}

export function useCompanionSync({
  agent,
  messages,
  activeRunId,
  activeReceiptUrl,
  enabled = true
}: UseCompanionSyncProps & { enabled?: boolean }) {
  // Sync agent instance
  useEffect(() => {
    if (!enabled) return;
    const globalServer = (global as any).companionServer;
    if (globalServer) {
      try {
        globalServer.agent = agent;
        globalServer.activeRunId = activeRunId;
        globalServer.activeReceiptUrl = activeReceiptUrl;
      } catch {
        // Guard against any companion server property assignment crashes
      }
    }
    return () => {
      // A remount/replacement must not leave browser commands routed to an
      // agent whose TUI listeners have been removed. Do not clear a new owner.
      if (globalServer?.agent === agent) {
        delete globalServer.agent;
        delete globalServer.activeRunId;
        delete globalServer.activeReceiptUrl;
      }
    };
  }, [agent, activeRunId, activeReceiptUrl, enabled]);

  // Sync message history dynamically
  useEffect(() => {
    if (!enabled) return;
    const globalServer = (global as any).companionServer;
    if (globalServer) {
      try {
        globalServer.lastHistory = messages;
        if (typeof globalServer.sendUpdate === 'function') {
          globalServer.sendUpdate('sync', messages);
        }
      } catch {
        // Guard against companion broadcast failures
      }
    }
  }, [messages, enabled]);

  // Sync tmux sessions dynamically
  useEffect(() => {
    if (!enabled) return;
    const syncTmuxToCompanion = () => {
      const globalServer = (global as any).companionServer;
      if (globalServer) {
        try {
          globalServer.lastTmux = agent.tmuxSessions ?? [];
          if (typeof globalServer.sendUpdate === 'function') {
            globalServer.sendUpdate('tmux', globalServer.lastTmux);
          }
        } catch {
          // Guard against companion broadcast failures
        }
      }
    };

    syncTmuxToCompanion();
    agent.on('tmux:update' as any, syncTmuxToCompanion);

    return () => {
      agent.off('tmux:update' as any, syncTmuxToCompanion);
    };
  }, [agent, enabled]);

  // Sync real-time agent events to companion live!
  useEffect(() => {
    if (!enabled) return;
    const publish = (type: string, data: unknown) => {
      const server = (global as any).companionServer;
      try { server?.sendUpdate?.(type, data); }
      catch { /* A closed companion must not interrupt the terminal stream. */ }
    };
    const handleOutputLine = (data: any) => {
      publish('tmux:line', data);
    };

    const handleCommandSent = (data: any) => {
      publish('tmux:command', data);
    };

    const handleToolCall = (name: string, args: any) => {
      publish('agent:tool', { name, args });
    };

    const handleStreamDelta = (delta: string, fullText: string) => {
      publish('agent:delta', { delta, fullText });
    };

    agent.on('tmux.output.line' as any, handleOutputLine);
    agent.on('tmux.command.sent' as any, handleCommandSent);
    agent.on('tool:call' as any, handleToolCall);
    agent.on('stream:delta' as any, handleStreamDelta);

    return () => {
      agent.off('tmux.output.line' as any, handleOutputLine);
      agent.off('tmux.command.sent' as any, handleCommandSent);
      agent.off('tool:call' as any, handleToolCall);
      agent.off('stream:delta' as any, handleStreamDelta);
    };
  }, [agent, enabled]);
}
