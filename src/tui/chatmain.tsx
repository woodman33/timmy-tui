#!/usr/bin/env node
// `timmy chat` — standalone WALNUT counterflow surface (work order p12).
// Owns only its own keys (^C quits); the frozen dispatcher is used as a
// library (FocusProvider) and never modified. READ-ONLY law: chat emits
// commands, never edits receipts (DESIGN.md §1).
import React from 'react';
import { render, useApp, useInput, useWindowSize } from 'ink';
import { createAgent } from '../agent/core.js';
import { loadConfig } from '../utils/config.js';
import { FocusProvider } from './hooks/useKeyDispatcher.js';
import { ViewportContext } from './layout.js';
import { ChatSurface } from './components/ChatSurface.js';
import type { AgentConfig } from '../types/index.js';

function Inner({ agent }: { agent: ReturnType<typeof createAgent> }) {
  const { exit } = useApp();
  useInput((c, key) => { if (key.ctrl && c === 'c') exit(); });
  const { columns, rows } = useWindowSize();
  return (
    <ViewportContext.Provider value={{ w: Math.max(60, (columns || 100) - 2), h: Math.max(12, (rows || 30) - 1) }}>
      <ChatSurface agent={agent} keys="local" />
    </ViewportContext.Provider>
  );
}

const cfg = loadConfig() as unknown as Record<string, unknown>;
const agentConfig: AgentConfig = {
  apiKey: String(cfg.apiKey || process.env.OPENROUTER_API_KEY || ''), // R4 (H87): never a placeholder key
  model: String(cfg.model ?? process.env.TIMMY_MODEL ?? 'anthropic/claude-3-5-sonnet'),
  instructions: 'You are TIMMY, a terminal coding agent. Answer in concise markdown. Every run seals a receipt.',
} as AgentConfig;

process.stdout.write('\x1Bc');
render(
  <FocusProvider>
    <Inner agent={createAgent(agentConfig)} />
  </FocusProvider>
);
