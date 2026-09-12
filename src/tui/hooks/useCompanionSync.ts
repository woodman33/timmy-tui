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
        if (activeRunId) globalServer.activeRunId = activeRunId;
        if (activeReceiptUrl) globalServer.activeReceiptUrl = activeReceiptUrl;
      } catch {
        // Guard against any companion server property assignment crashes
      }
    }
  }, [agent, activeRunId, activeReceiptUrl]);

  // Sync message history dynamically
  useEffect(() => {
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
  }, [messages]);

  // Sync tmux sessions dynamically
  useEffect(() => {
    const syncTmuxToCompanion = () => {
      const globalServer = (global as any).companionServer;
      if (globalServer) {
        try {
          globalServer.lastTmux = agent.tmuxSessions;
          if (typeof globalServer.sendUpdate === 'function') {
            globalServer.sendUpdate('tmux', agent.tmuxSessions);
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
  }, [agent]);

  // Sync real-time agent events to companion live!
  useEffect(() => {
    const handleOutputLine = (data: any) => {
      const globalServer = (global as any).companionServer;
      if (globalServer && typeof globalServer.sendUpdate === 'function') {
        globalServer.sendUpdate('tmux:line', data);
      }
    };

    const handleCommandSent = (data: any) => {
      const globalServer = (global as any).companionServer;
      if (globalServer && typeof globalServer.sendUpdate === 'function') {
        globalServer.sendUpdate('tmux:command', data);
      }
    };

    const handleToolCall = (name: string, args: any) => {
      const globalServer = (global as any).companionServer;
      if (globalServer && typeof globalServer.sendUpdate === 'function') {
        globalServer.sendUpdate('agent:tool', { name, args });
      }
    };

    const handleStreamDelta = (delta: string, fullText: string) => {
      const globalServer = (global as any).companionServer;
      if (globalServer && typeof globalServer.sendUpdate === 'function') {
        globalServer.sendUpdate('agent:delta', { delta, fullText });
      }
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
  }, [agent]);
}
