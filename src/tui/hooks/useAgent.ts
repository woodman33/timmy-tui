import { useState, useEffect, useCallback, useRef } from 'react';
import type { Agent } from '../../agent/core.js';
import type { Message } from '../../types/index.js';

export interface AgentUIState {
  messages: Message[];
  streamingText: string;
  isThinking: boolean;
  isStreaming: boolean;
  currentTools: string[];
  error: Error | null;
  totalTokens: number;
  totalCost: number;
  model: string;
  modelHealthStatus: 'UNTESTED' | 'READY' | 'ERROR' | 'FALLBACK READY';
}

function initialAgentState(agent: Agent): AgentUIState {
  let history: Message[] = [];
  try {
    const conv = (agent as any).conversation;
    if (conv?.getHistory) {
      history = conv
        .getHistory()
        .filter((m: any) => m.role === 'user' || m.role === 'assistant')
        .map((m: any) => ({ role: m.role, content: m.content, timestamp: m.timestamp ?? Date.now() }));
    }
  } catch {
    history = [];
  }
  return {
    messages: history,
    streamingText: '',
    isThinking: false,
    isStreaming: false,
    currentTools: [],
    error: null,
    totalTokens: 0,
    totalCost: (agent as any).totalCost || 0,
    model: agent.getModel(),
    modelHealthStatus: (agent as any).modelHealthStatus || 'UNTESTED',
  };
}

export function useAgent(agent: Agent) {
  // The default shell begins with a NOOP agent, then creates the real one on
  // first send. Reset during render so downstream effects never publish the
  // previous agent's history (or []) before retained history is hydrated.
  const [state, setState] = useState<AgentUIState>(() => initialAgentState(agent));
  const [stateAgent, setStateAgent] = useState(() => agent);
  const toolsRef = useRef<string[]>([]);
  let currentState = state;
  if (stateAgent !== agent) {
    currentState = initialAgentState(agent);
    setStateAgent(agent);
    setState(currentState);
    toolsRef.current = [];
  }

  useEffect(() => {
    const handlers = {
      'thinking:start': () => {
        toolsRef.current = [];
        setState(s => ({
          ...s, isThinking: true, isStreaming: true, streamingText: '',
          currentTools: [], error: null,
        }));
      },
      'stream:delta': (delta: string, accumulated: string) => {
        setState(s => ({ ...s, streamingText: accumulated }));
      },
      'stream:end': (text: string) => {
        setState(s => ({
          ...s, isStreaming: false, isThinking: false, streamingText: '',
          messages: [...s.messages, { role: 'assistant', content: text, timestamp: Date.now() }],
        }));
      },
      'tool:call': (name: string) => {
        toolsRef.current = [...toolsRef.current, name];
        setState(s => ({ ...s, currentTools: [...toolsRef.current] }));
      },
      'tool:result': () => {
        setState(s => ({ ...s }));
      },
      'error': (error: Error) => {
        setState(s => ({ ...s, error, isThinking: false, isStreaming: false }));
      },
      'message:user': (message: Message) => {
        setState(s => ({ ...s, messages: [...s.messages, message] }));
      },
      'cost:update': (cost: number, total: number) => {
        setState(s => ({ ...s, totalCost: total }));
      },
      'model:switch': (model: string) => {
        setState(s => ({ ...s, model, modelHealthStatus: (agent as any).modelHealthStatus }));
      },
      'model:health': (status: 'UNTESTED' | 'READY' | 'ERROR' | 'FALLBACK READY') => {
        setState(s => ({ ...s, modelHealthStatus: status }));
      },
      'thinking:end': () => {
        setState(s => ({ ...s, isThinking: false }));
      },
    };

    for (const [event, handler] of Object.entries(handlers)) {
      agent.on(event as any, handler as any);
    }

    // Reflect provider health immediately on mount instead of sitting at UNTESTED
    try {
      (agent as any).runStartupHealthCheck?.();
    } catch { /* never block mount on a health probe */ }

    return () => {
      for (const [event, handler] of Object.entries(handlers)) {
        agent.off(event as any, handler as any);
      }
    };
  }, [agent]);

  const send = useCallback(async (text: string) => {
    try {
      return await agent.send(text);
    } catch (e) {
      // Error is already emitted via event
      return null;
    }
  }, [agent]);

  const clearHistory = useCallback(() => {
    agent.clearHistory();
    setState(s => ({ ...s, messages: [] }));
  }, [agent]);

  const switchModel = useCallback((model: string) => {
    agent.setModel(model);
  }, [agent]);

  return { ...currentState, send, clearHistory, switchModel };
}
