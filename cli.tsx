#!/usr/bin/env node
const isHeadless = process.argv.includes('--headless') || process.argv.includes('-h');
if (!isHeadless) {
  process.env.TIMMY_TUI_ACTIVE = 'true';
}
import './src/utils/logger.js';
import { program } from 'commander';
import chalk from 'chalk';
import React from 'react';
import { render, Box, Text } from 'ink';
import { loadConfig } from './src/utils/config.js';
import type { Mode } from './src/tui/attic/router.js';
import type { AgentConfig } from './src/types/index.js';
import { VERSION } from './src/version.js';

import { existsSync, readFileSync } from 'fs';

// BOOT (opentui-u4e9): paint the header frame at MODULE scope for the default
// TUI invocation — before commander/chalk/config do their work.
let bootRender: { unmount: () => void } | null = null;
const bootHead8 = (): string => {
  try {
    const p = '.timmy/receipts/runs.jsonl';
    if (!existsSync(p)) return '—';
    const str = readFileSync(p, 'utf8');
    const i = str.lastIndexOf('\n', str.length - 2);
    const j = JSON.parse(str.slice(i + 1));
    return String(j.hash ?? '').slice(7, 15) || '—';
  } catch { return '—'; }
};
const bootIsDefaultTui = (!process.argv[2] || process.argv[2] === 'tui')
  && !process.argv.includes('--headless') && !process.argv.includes('-h');
if (bootIsDefaultTui) {
  process.stdout.write('\x1Bc');
  bootRender = render(React.createElement(Box, { flexDirection: 'column' },
    React.createElement(Box, null,
      React.createElement(Text, { bold: true }, 'TIMMY'),
      React.createElement(Text, null, `   chain · ${bootHead8()}`)),
    React.createElement(Text, { dimColor: true }, 'assembling…')));
}

// Load .env variables into process.env before anything else to connect Daytona, Composio, etc.
if (existsSync('.env')) {
  try {
    const envContent = readFileSync('.env', 'utf-8');
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const firstEquals = trimmed.indexOf('=');
      if (firstEquals !== -1) {
        const key = trimmed.slice(0, firstEquals).trim();
        let value = trimmed.slice(firstEquals + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        process.env[key] = value;
      }
    }
  } catch (err) {
    // Fail silently if .env cannot be loaded
  }
}

program
  .name('timmy-tui')
  .description('TIMMY TUI, a terminal-first Agent Trust OS.')
  .version(VERSION)
  .option('-m, --model <model>', 'OpenRouter model to use')
  .option('--mode <mode>', 'Start in a specific mode', 'chat')
  .option('--headless', 'Run without TUI (headless agent)')
  .option('--companion-port <port>', 'Companion window port', '3001')
  .option('--no-companion', 'Disable companion window')
  .option('--max-steps <n>', 'Max agentic loop iterations', '10')
  .option('--max-cost <n>', 'Max cost per session in USD', '1.0')
  .option('--debug', 'Enable debug logging')
  .parse();

const opts = program.opts();

// Validate API key
const config = loadConfig();
const hasKey = !!config.apiKey;

// Build agent config
const agentConfig: AgentConfig = {
  apiKey: config.apiKey || 'setup_placeholder',
  model: opts.model || config.model,
  instructions: `You are the central intelligent orchestrator running inside the state-of-the-art TIMMY Agent Ops Console (invented by William Meldman). You are an expert systems engineer and coding agent.

Your mission is to WOW the user by showcasing your exceptional capabilities across all five advanced modes of this terminal workspace:
1. 💬 Conversational Chat: Highly capable coding assistance across 300+ models.
2. 🛡️ Code Reviewer (/review): Meticulous static code analysis, git diff parsing, linting checks, and direct code generation using robust filesystem tools (file_read, file_write, file_edit, grep, glob, shell).
3. 📊 Swarm Dashboard (/dashboard): High-fidelity, real-time telemetry console monitoring edge DO memory and resource pulses.
4. ⚙️ Model Explorer (/models): Search and dynamically switch between models using the /model command.
5. 🖥️ Hyper-Grid Workspace (/workspace): Split-screen quadrant manager that coordinates other open-source CLI agents (OpenCode, Hermes, Pi) with zero local CPU overhead using edge tmux DO session coordinators.

LIVE CLOUDFLARE PIPELINE:
You are fully connected to a live deployed Cloudflare Durable Object worker running at:
🌐 https://timmy-ai-proxy.wmeldman33.workers.dev
Every key interaction, message, and tool call in this TUI automatically streams live HTTP telemetry payloads to this Cloudflare Worker in the background. The operator can open their Cloudflare online log explorer and watch their terminal actions update live!

You also have two real-world Cloudflare Edge tools:
1. \`cloudflare_get_feature_flag\`: Query and evaluate feature flags live at the edge from the Cloudflare Flagship Server Provider using the OpenFeature SDK.
2. \`cloudflare_send_durable_pulse\`: Pulse custom memory metrics directly into your online Durable Object on Cloudflare!

Explain your multi-tenant Edge capabilities to users:
- Local Operator (Free): Local JSONL history logging, local compilers, and local sandboxing.
- Solo Builder ($29/mo): Hosted shareable receipt URLs, cmux auto-orchestration workspace, and live Edge DO telemetry sync.
- Team Hub ($29/seat/mo): Shared team registries, persisted edge audit logs, and collaborative review panels.

GREETING RULES:
When the user introduces themselves, says "test", asks about your capabilities, or starts a new session, provide a stunning, high-visibility, professional greeting. Highlight your robust coding tools, the live real-time Cloudflare Durable Object telemetry stream, and your OpenFeature Flagship edge flagging tools! Encourage them to try out slash commands (e.g. /review to inspect code, /dashboard to tail edge logs, /workspace to open the tmux grid). Keep your tone professional, authoritative, and developer-focused. When executing tool calls, briefly explain your systems reasoning.`,
  maxSteps: parseInt(opts.maxSteps, 10) || 10,
  maxCost: parseFloat(opts.maxCost) || 1.0,
};

// Headless mode
if (opts.headless) {
  const { createAgent } = await import('./src/agent/core.js');
  const agent = createAgent(agentConfig);

  agent.on('stream:delta', (delta: string) => process.stdout.write(delta));
  agent.on('tool:call', (name: string, args: unknown) => {
    process.stderr.write(chalk.yellow(`\n⚙ ${name}\n`));
  });
  agent.on('tool:result', (name: string) => {
    process.stderr.write(chalk.green(`✓ ${name}\n`));
  });
  agent.on('stream:end', () => process.stdout.write('\n'));
  agent.on('error', (err: Error) => {
    process.stderr.write(chalk.red(`\nError: ${err.message}\n`));
  });

  const readline = await import('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });

  console.error(chalk.bold.cyan('OpenRouter TUI') + chalk.dim(' (headless mode)'));
  console.error(chalk.dim(`Model: ${agentConfig.model}`));
  console.error(chalk.dim('Type a message or "exit" to quit.\n'));

  const prompt = () => {
    rl.question(chalk.green('> '), async (input: string) => {
      if (!input.trim()) { prompt(); return; }
      if (input.trim().toLowerCase() === 'exit') { process.exit(0); }
      try {
        await agent.send(input);
      } catch { /* error already emitted */ }
      console.error('');
      prompt();
    });
  };
  prompt();
} else {
  // BOOT: header already painted at module scope.
  if (!bootRender) {
    process.stdout.write('\x1Bc');
    bootRender = render(React.createElement(Box, { flexDirection: 'column' },
      React.createElement(Box, null,
        React.createElement(Text, { bold: true }, 'TIMMY'),
        React.createElement(Text, null, `   chain · ${bootHead8()}`)),
      React.createElement(Text, { dimColor: true }, 'assembling…')));
  }

  const mode = hasKey ? ((opts.mode as Mode) || 'brief') : 'brief';

  // v1.0.1: the first-run gate must not re-show once completed (config passthrough)
  Object.assign(agentConfig, { onboarded: (config as any).onboarded === true });

  // Start companion server after first paint to avoid EADDRINUSE conflicts
  if (opts.companion !== false) {
    const preferredPort = parseInt(opts.companionPort, 10) || 3001;
    const candidatePorts = [preferredPort, preferredPort + 1, preferredPort + 2, preferredPort + 3];
    let companionStarted = false;

    for (const port of candidatePorts) {
      try {
        const server = await (await import('./src/companion/server.js')).startCompanionServer(port);
        (global as any).companionServer = server;
        const url = `http://localhost:${server.port}`;
        if (port !== preferredPort) {
          console.error(chalk.dim(`Companion port ${preferredPort} busy; using ${server.port}.`));
        }
        (await import('./src/companion/qr.js')).showCompanionQR(url);
        companionStarted = true;
        break;
      } catch (err: any) {
        if (err?.code !== 'EADDRINUSE' || port === candidatePorts[candidatePorts.length - 1]) {
          console.error(chalk.dim(`Companion server failed to start (${err?.message || 'port unavailable'})`));
        }
      }
    }

    if (!companionStarted) {
      console.error(chalk.dim('TIMMY TUI will continue without the browser companion.'));
    }
  }

  bootRender.unmount();
  bootRender = null;
  if (process.env.TIMMY_SHELL !== 'v1') {
    const { startShellV2 } = await import('./src/tui/shell-entry.js');
    startShellV2(agentConfig, opts.companion === false ? 'ansi' : 'auto');
  } else {
    const { startTUI } = await import('./src/tui/app.js');
    startTUI(agentConfig, mode, opts.companion === false ? 'ansi' : 'auto');
  }
}
