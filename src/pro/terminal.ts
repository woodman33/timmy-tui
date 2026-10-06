// `timmy pro` in a real terminal: stdout, stderr, the browser, stdin and real
// sleeps around runProCli. src/cli.ts calls runProCommand.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { answerHelpOrUsageError, runProCli, type ProCliContext, type ProCliIO } from './cli.js';
import { resolveProRuntime, type Env, type RuntimeOverrides } from './runtime.js';
import { ProConfigError } from './settings.js';

/** Runs `timmy pro …` and returns its exit code. Help and usage errors need no configuration. */
export async function runProCommand(argv: readonly string[], env: Env = process.env): Promise<number> {
  const io = terminalIO();
  const answered = answerHelpOrUsageError(argv, io);
  if (answered !== null) return answered;
  let ctx: ProCliContext;
  try {
    ctx = await createProCliContext(env, io);
  } catch (error) {
    if (!(error instanceof ProConfigError)) throw error;
    io.err(error.message);
    return 2;
  }
  return runProCli(argv, ctx);
}

export async function createProCliContext(env: Env = process.env, io: ProCliIO = terminalIO(), overrides: RuntimeOverrides = {}): Promise<ProCliContext> {
  const { settings, manager } = await resolveProRuntime(env, overrides);
  return { settings, manager, io };
}

function terminalIO(): ProCliIO {
  return {
    out: (text) => { process.stdout.write(`${text}\n`); },
    err: (text) => { process.stderr.write(`${text}\n`); },
    openUrl: openInBrowser,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    readStdin: readKeyLine,
  };
}

/** Best effort: the URL is always printed too, so a machine without a browser loses nothing. */
function openInBrowser(url: string): void {
  const [command, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : ['xdg-open', [url]];
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => { /* no opener available */ });
  child.unref();
}

/** The first line of stdin; on a terminal, asks for it first. */
function readKeyLine(): Promise<string> {
  if (process.stdin.isTTY) process.stderr.write('Paste your Timmy Pro license key and press Enter: ');
  return new Promise((resolve) => {
    const lines = createInterface({ input: process.stdin, terminal: false });
    let answered = false;
    const finish = (line: string) => {
      if (answered) return;
      answered = true;
      lines.close();
      resolve(line);
    };
    lines.once('line', finish);
    lines.once('close', () => finish(''));
  });
}
