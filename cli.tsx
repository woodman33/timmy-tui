#!/usr/bin/env node
const isHeadless = process.argv.includes('--headless') || process.argv.includes('-h');
if (!isHeadless) {
  process.env.TIMMY_TUI_ACTIVE = 'true';
}
import './src/utils/blank-slate-guard.js'; // blank-slate-v1k9: must stay the FIRST import (imports are hoisted)
import { writeLog } from './src/utils/logger.js';
import { program } from 'commander';
import chalk from 'chalk';
import { colors } from './src/tui/theme.js';
import React from 'react';
import { render } from 'ink';
import { loadConfig } from './src/utils/config.js';
import type { Mode } from './src/tui/attic/router.js';
import type { AgentConfig } from './src/types/index.js';
import { VERSION } from './src/version.js';
import { TerminalSession } from './src/term/session.js';
import { BootFrame } from './src/tui/ui/BootFrame.js';
import { screenStream } from './src/term/screen-stream.js';
import { currentCapabilities } from './src/term/capabilities.js';
import { measureTerminal } from './src/term/probe.js';
import { LANES_OPTION_WORDS, laneMultiplexer } from './src/agent/lane-server.js';

import { existsSync, readFileSync } from 'fs';

// BOOT (opentui-u4e9): paint the header frame at MODULE scope for the default
// TUI invocation — before commander/chalk/config do their work.
let bootRender: { unmount: () => void; clear?: () => void } | null = null;
// C-11: the monitor owns its own screen (the alternate buffer) and gives the terminal back on every
// exit path (return, Ctrl+C 130, SIGTERM 143, uncaught 1). It used to send ESC c, a full reset that
// wiped the operator's scrollback, and drew in the main screen.
let monitorScreen: TerminalSession | null = null;
const enterMonitorScreen = (): TerminalSession => {
  if (monitorScreen) return monitorScreen;
  monitorScreen = new TerminalSession({ stdin: process.stdin, stdout: process.stdout, stderr: process.stderr });
  monitorScreen.enterAltScreen();
  monitorScreen.install();
  return monitorScreen;
};
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
  // The boot frame tears down before the screen is restored, like the shell after it (row 27).
  enterMonitorScreen().beforeRestore(() => bootRender?.unmount());
  bootRender = render(React.createElement(BootFrame, { head: bootHead8() }), { stdout: screenStream(process.stdout) });
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
  // R4 (H84): the companion is this computer's only unless the operator asks for the local network, for a phone
  .option('--lan', 'Also serve the companion on your local network (plain HTTP; its QR code holds its token): only on a network you trust')
  // R4 (H87): no lane program and no tmux session start unless the operator asks for them here (src/agent/lane-server.ts)
  .option('--lanes', LANES_OPTION_WORDS)
  .option('--max-steps <n>', 'Max agentic loop iterations', '10')
  .option('--max-cost <n>', 'Max cost per session in USD', '1.0')
  .option('--debug', 'Enable debug logging')
  .parse();

const opts = program.opts();

// Validate API key
const config = loadConfig();
const hasKey = !!config.apiKey;

// Build agent config. R4 (H87): no placeholder key: with no model key the agent has none, says so, and asks nothing of a model.
const agentConfig: AgentConfig = {
  apiKey: config.apiKey || '',
  model: opts.model || config.model,
  // R6 (lead, H146's finding): these words say only what this shell does. The earlier text told the model that every key
  // and message streamed live to a Cloudflare worker and that paid plans existed; neither was ever true of this build.
  instructions: `You are TIMMY, a coding agent in the legacy terminal shell (TIMMY_SHELL=v1). Answer in concise markdown.

This shell's modes: Chat (streaming answers and tool use); Code Review (diffs, the linter and the file tools: file_read, file_write, file_edit, grep, glob, shell); Dashboard (agents, models, resources); Model Explorer (OpenRouter's models); Workspace (tmux panes). Use only the tools this mode gives you, and describe a screen only from what it shows.

What this build does not do: it sends no key presses anywhere. Run events go to a worker only when the operator names one for this run (TIMMY_TELEMETRY_URL or the config's telemetryUrl); a configured edge host alone sends nothing. Timmy has no plans, prices or hosted accounts: never describe any.

Two Cloudflare tools are listed and need setup before they do anything: cloudflare_get_feature_flag reads a flag only inside a Cloudflare Worker with a Flagship binding, so in this terminal it cannot; cloudflare_send_durable_pulse needs an edge host (TIMMY_EDGE_HOST or the private overlay) and the operator's approval for each call. Say so instead of claiming a live connection.

When you call a tool, say briefly why, and report what it returned, including failures.`,
  maxSteps: parseInt(opts.maxSteps, 10) || 10,
  maxCost: parseFloat(opts.maxCost) || 1.0,
};

// Headless mode
if (opts.headless) {
  const { createAgent } = await import('./src/agent/core.js');
  const agent = createAgent(agentConfig);

  agent.on('stream:delta', (delta: string) => process.stdout.write(delta));
  agent.on('tool:call', (name: string, args: unknown) => {
    process.stderr.write(colors.warn(`\n⚙ ${name}\n`));
  });
  agent.on('tool:result', (name: string) => {
    process.stderr.write(colors.primary(`✓ ${name}\n`));
  });
  agent.on('stream:end', () => process.stdout.write('\n'));
  agent.on('error', (err: Error) => {
    process.stderr.write(colors.refuse(`\nError: ${err.message}\n`));
  });

  const readline = await import('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });

  console.error(chalk.bold('OpenRouter TUI') + chalk.dim(' (headless mode)'));
  console.error(chalk.dim(`Model: ${agentConfig.model}`));
  console.error(chalk.dim('Type a message or "exit" to quit.\n'));

  const prompt = () => {
    rl.question(colors.primary('> '), async (input: string) => {
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
    enterMonitorScreen().beforeRestore(() => bootRender?.unmount());
    bootRender = render(React.createElement(BootFrame, { head: bootHead8() }), { stdout: screenStream(process.stdout) });
  }

  const mode = hasKey ? ((opts.mode as Mode) || 'brief') : 'brief';

  // v1.0.1: the first-run gate must not re-show once completed (config passthrough)
  // R4 (H87): the lanes only when asked (--lanes), carried to every agent the monitor makes (src/agent/lane-server.ts laneOptions)
  Object.assign(agentConfig, { onboarded: (config as any).onboarded === true, lanes: laneMultiplexer(opts.lanes === true, process.env) });

  // Start companion server after first paint to avoid EADDRINUSE conflicts
  // Fourth order, step 2 (row 52): its notes go where its URL and QR code go, the companion's log, while
  // the monitor owns the screen; a note on stderr was drawn over the monitor's header, in dim (B3 bans dim).
  const companionNote = (level: 'info' | 'warn', text: string): void => {
    if (process.env.TIMMY_TUI_ACTIVE === 'true') writeLog('companion.log', level, text);
    else console.error(text);
  };
  if (opts.companion !== false) {
    const preferredPort = parseInt(opts.companionPort, 10) || 3001;
    const candidatePorts = [preferredPort, preferredPort + 1, preferredPort + 2, preferredPort + 3];
    let companionStarted = false;

    for (const port of candidatePorts) {
      try {
        // R4 (H84): on 127.0.0.1 with a token made now; with --lan, on the local network too
        const server = await (await import('./src/companion/server.js')).startCompanionServer(port, { lan: opts.lan === true });
        (global as any).companionServer = server;
        if (port !== preferredPort) companionNote('info', `Companion port ${preferredPort} busy; using ${server.port}.`);
        (await import('./src/companion/qr.js')).showCompanionQR(server);
        companionStarted = true;
        break;
      } catch (err: any) {
        if (err?.code !== 'EADDRINUSE' || port === candidatePorts[candidatePorts.length - 1]) {
          companionNote('warn', `Companion server failed to start (${err?.message || 'port unavailable'})`);
        }
      }
    }

    if (!companionStarted) {
      companionNote('warn', 'TIMMY TUI will continue without the browser companion.');
    }
  }

  // B2 (row 28): measure the terminal's colors (TIMMY_PALETTE, else OSC 11 and OSC 4, 200ms) while the
  // boot frame is up; the shell draws the law in the palette's slots chosen from this.
  const monitorCaps = currentCapabilities();
  const measured = await measureTerminal(monitorCaps, process.env, { stdin: process.stdin, stdout: process.stdout });

  // The boot frame is erased, not left above the shell (it stayed on screen: C-0c, C-11).
  bootRender.clear?.();
  bootRender.unmount();
  bootRender = null;
  if (process.env.TIMMY_SHELL !== 'v1') {
    const { startShellV2 } = await import('./src/tui/shell-entry.js');
    startShellV2(agentConfig, opts.companion === false ? 'ansi' : 'auto', enterMonitorScreen(), { color: monitorCaps.color, measured });
  } else {
    const { startTUI } = await import('./src/tui/app.js');
    startTUI(agentConfig, mode, opts.companion === false ? 'ansi' : 'auto');
  }
}
