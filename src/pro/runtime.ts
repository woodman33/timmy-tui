// The one place `timmy pro` is wired to the real world: environment, the
// license file under TIMMY_HOME, the network, the clock, the terminal.
// Later Pro features call loadLicenseManager() and check allowsFeature().

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { timmyHome } from '../utils/init.js';
import { HttpProService, type ProService } from './client.js';
import { runProCli, type ProCliContext, type ProCliIO } from './cli.js';
import { importVerifyKey } from './license.js';
import { LicenseManager } from './manager.js';
import { ProConfigError, resolveProSettings, type ProSettings } from './settings.js';
import { FileLicenseVault } from './vault.js';

type Env = Readonly<Record<string, string | undefined>>;

/** Runs `timmy pro …` for the main CLI and returns its exit code. */
export async function runProCommand(argv: readonly string[], env: Env = process.env): Promise<number> {
  let ctx: ProCliContext;
  try {
    ctx = await createProCliContext(env);
  } catch (error) {
    if (!(error instanceof ProConfigError)) throw error;
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
  return runProCli(argv, ctx);
}

export async function createProCliContext(env: Env = process.env, io: ProCliIO = terminalIO()): Promise<ProCliContext> {
  const { settings, service, manager } = await assemble(env);
  return { settings, service, manager, io };
}

/** The license manager for this machine: the entry point for gating Pro features. */
export async function loadLicenseManager(env: Env = process.env): Promise<LicenseManager> {
  return (await assemble(env)).manager;
}

async function assemble(env: Env): Promise<{ settings: ProSettings; service: ProService | null; manager: LicenseManager }> {
  const settings = resolveProSettings(env, env.TIMMY_HOME?.trim() || timmyHome());
  const service = settings.serviceUrl ? new HttpProService(settings.serviceUrl) : null;
  const publicKey = settings.publicKey ? await verifyKey(settings.publicKey, settings.publicKeySource) : null;
  const manager = new LicenseManager({
    vault: new FileLicenseVault(settings.licensePath),
    service,
    publicKey,
    now: () => Math.floor(Date.now() / 1000),
  });
  return { settings, service, manager };
}

async function verifyKey(raw: string, source: ProSettings['publicKeySource']): Promise<CryptoKey> {
  try {
    return await importVerifyKey(raw);
  } catch {
    const origin = source === 'env' ? 'TIMMY_PRO_PUBLIC_KEY' : 'the built-in Pro public key';
    throw new ProConfigError(`${origin} is not a valid Timmy Pro public key (32 raw bytes, base64url). Check TIMMY_PRO_PUBLIC_KEY.`);
  }
}

function terminalIO(): ProCliIO {
  return {
    out: (text) => { process.stdout.write(`${text}\n`); },
    err: (text) => { process.stderr.write(`${text}\n`); },
    openUrl: openInBrowser,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    readStdin: readFirstLine,
  };
}

/** Best effort: the URL is always printed too, so a machine without a browser loses nothing. */
function openInBrowser(url: string): void {
  const [command, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]];
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => { /* no opener available */ });
  child.unref();
}

function readFirstLine(): Promise<string> {
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
