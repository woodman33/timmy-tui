import chalk from 'chalk';
import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { theme } from '../tui/theme.js';

// Ensure logs/ directory and all bounded log files exist automatically upon initialization
try {
  if (!existsSync('logs')) {
    mkdirSync('logs');
  }
  const logFiles = [
    'timmy-tui.log',
    'companion.log',
    'browser-launcher.log',
    'workspace-launcher.log',
    'agent-events.log'
  ];
  for (const file of logFiles) {
    const logPath = join('logs', file);
    if (!existsSync(logPath)) {
      writeFileSync(logPath, '', 'utf-8');
    }
  }
} catch (e) {
  // Fail silently
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

let currentLevel: LogLevel = 'info';
const levels: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export function setLogLevel(level: LogLevel) {
  currentLevel = level;
}

// Global file-logging gate — toggled live from the Options panel so the
// "Logs ON/OFF" setting actually controls writes instead of being cosmetic.
let fileLogsEnabled = true;

export function setLogsEnabled(enabled: boolean) {
  fileLogsEnabled = enabled;
}

export function isLogsEnabled(): boolean {
  return fileLogsEnabled;
}

// Preserve original console methods
export const originalConsole = {
  log: console.log,
  error: console.error,
  warn: console.warn,
  info: console.info
};

export function writeLog(file: string, level: string, msg: string) {
  try {
    if (!fileLogsEnabled) return;
    if (!existsSync('logs')) {
      mkdirSync('logs');
    }
    const logPath = join('logs', file);
    const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${msg}\n`;
    appendFileSync(logPath, line, 'utf-8');

    // Truncate/rotate log file so it cannot grow forever
    const stats = statSync(logPath);
    if (stats.size > 200000) { // Limit size to 200KB
      const content = readFileSync(logPath, 'utf-8');
      const lines = content.split('\n');
      // Keep only last 200 lines
      const truncatedContent = lines.slice(-200).join('\n');
      writeFileSync(logPath, truncatedContent, 'utf-8');
    }
  } catch {
    // Fail silently
  }
}

function writeToLogFile(level: string, ...args: unknown[]) {
  const msg = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ');
  writeLog('companion.log', level, msg);
}

export const logger = {
  debug: (...args: unknown[]) => {
    writeToLogFile('debug', ...args);
    if (process.env.TIMMY_TUI_ACTIVE === 'true') return;
    if (levels[currentLevel] <= levels.debug) console.error(chalk.hex(theme.textMuted)('[DEBUG]', ...args));
  },
  info: (...args: unknown[]) => {
    writeToLogFile('info', ...args);
    if (process.env.TIMMY_TUI_ACTIVE === 'true') return;
    if (levels[currentLevel] <= levels.info) console.error(chalk.hex(theme.textPrimary)('[INFO]', ...args));
  },
  warn: (...args: unknown[]) => {
    writeToLogFile('warn', ...args);
    if (process.env.TIMMY_TUI_ACTIVE === 'true') return;
    if (levels[currentLevel] <= levels.warn) console.error(chalk.hex(theme.warn).bold('[WARN]', ...args));
  },
  error: (...args: unknown[]) => {
    writeToLogFile('error', ...args);
    if (process.env.TIMMY_TUI_ACTIVE === 'true') return;
    if (levels[currentLevel] <= levels.error) console.error(chalk.hex(theme.refuse)('[ERROR]', ...args));
  }
};

export const tuiLogger = {
  info: (...args: unknown[]) => writeLog('timmy-tui.log', 'info', args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ')),
  error: (...args: unknown[]) => writeLog('timmy-tui.log', 'error', args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ')),
  warn: (...args: unknown[]) => writeLog('timmy-tui.log', 'warn', args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' '))
};

export const browserLogger = {
  info: (...args: unknown[]) => writeLog('browser-launcher.log', 'info', args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ')),
  error: (...args: unknown[]) => writeLog('browser-launcher.log', 'error', args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ')),
  warn: (...args: unknown[]) => writeLog('browser-launcher.log', 'warn', args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' '))
};

export const workspaceLogger = {
  info: (...args: unknown[]) => writeLog('workspace-launcher.log', 'info', args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ')),
  error: (...args: unknown[]) => writeLog('workspace-launcher.log', 'error', args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ')),
  warn: (...args: unknown[]) => writeLog('workspace-launcher.log', 'warn', args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' '))
};

export const agentLogger = {
  info: (...args: unknown[]) => writeLog('agent-events.log', 'info', args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ')),
  error: (...args: unknown[]) => writeLog('agent-events.log', 'error', args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ')),
  warn: (...args: unknown[]) => writeLog('agent-events.log', 'warn', args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' '))
};

// Global console overrides to completely secure stdout/stderr streams while TUI is running
const formatArgs = (...args: unknown[]) =>
  args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ');

console.log = (...args: unknown[]) => {
  if (process.env.TIMMY_TUI_ACTIVE === 'true') {
    writeLog('timmy-tui.log', 'info', formatArgs(...args));
  } else {
    originalConsole.log(...args);
  }
};
console.error = (...args: unknown[]) => {
  if (process.env.TIMMY_TUI_ACTIVE === 'true') {
    writeLog('timmy-tui.log', 'error', formatArgs(...args));
  } else {
    originalConsole.error(...args);
  }
};
console.warn = (...args: unknown[]) => {
  if (process.env.TIMMY_TUI_ACTIVE === 'true') {
    writeLog('timmy-tui.log', 'warn', formatArgs(...args));
  } else {
    originalConsole.warn(...args);
  }
};
console.info = (...args: unknown[]) => {
  if (process.env.TIMMY_TUI_ACTIVE === 'true') {
    writeLog('timmy-tui.log', 'info', formatArgs(...args));
  } else {
    originalConsole.info(...args);
  }
};
