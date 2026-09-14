#!/usr/bin/env node
import chalk from 'chalk';
import { colors } from './src/tui/theme.js';
import { loadConfig } from './src/utils/config.js';
import { createAgent } from './src/agent/core.js';
import type { AgentConfig } from './src/types/index.js';

const config = loadConfig();

if (!config.apiKey) {
  console.error(colors.refuse('Error: OPENROUTER_API_KEY is required.'));
  console.error(chalk.dim('Set it via: export OPENROUTER_API_KEY=sk-or-v1-...'));
  process.exit(1);
}

const agentConfig: AgentConfig = {
  apiKey: config.apiKey,
  model: config.model,
  instructions: 'You are a helpful AI coding assistant. Be concise and accurate.',
  maxSteps: 10,
  maxCost: 1.0,
};

const agent = createAgent(agentConfig);

agent.on('stream:delta', (delta: string) => process.stdout.write(delta));
agent.on('tool:call', (name: string) => {
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

async function prompt() {
  rl.question(colors.primary('> '), async (input: string) => {
    if (!input.trim()) { await prompt(); return; }
    if (input.trim().toLowerCase() === 'exit') { process.exit(0); }
    try {
      await agent.send(input);
    } catch { /* error already emitted */ }
    console.error('');
    await prompt();
  });
}

await prompt();
