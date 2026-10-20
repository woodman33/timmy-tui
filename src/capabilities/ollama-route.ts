/**
 * R6 (H140; the R5 interaction review, defect 2: tab 9 said "Ollama (local models) needs setup · do: brew install ollama…" on
 * Linux while Ollama answered at the address the chat asks): the one Ollama address every check asks, and the steps that set
 * Ollama up on this computer.
 *
 * Timmy asks Ollama over HTTP only, so whether it needs setup follows what that address answered, never whether an `ollama`
 * program is on the PATH (the program is needed only to start Ollama or pull a model here). The address is the one the local
 * chat asks: the chat setup's record when the chat is set to the local model (src/agent/chat-route.ts resolveChatRoute), else
 * OLLAMA_HOST (or OLLAMA_BASE_URL), else Ollama's default. /tools, `timmy workspace check` and the workspace frame's card all
 * ask and name that one address (before, /tools asked OLLAMA_HOST or the default while the chat answered at its own address).
 *
 * A remedy names steps that fit this computer: Homebrew only on macOS; the download page for Linux and Windows; `ollama serve`
 * when the program is here; and, when the address is what is wrong, the setting that names it (the chat setup's, or the
 * variable it was read from). Each step fits `do: ` at 80 columns (69 characters at most).
 */
import { resolveChatRoute } from '../agent/chat-route.js';

type Env = Record<string, string | undefined>;

/** Where the address came from: the chat setup's record, a variable, or Ollama's default. */
export type OllamaFrom = 'the chat setup' | 'OLLAMA_HOST' | 'OLLAMA_BASE_URL' | 'the default';

export const OLLAMA_DEFAULT_ADDRESS = 'http://127.0.0.1:11434';

/** The address the checks ask and the card names, and where it came from. */
export function ollamaRoute(env: Env = process.env): { origin: string; from: OllamaFrom } {
  try {
    const r = resolveChatRoute({ env });
    if (r.kind === 'local' && !('error' in r.at)) return { origin: r.at.origin, from: 'the chat setup' };
  } catch { /* the setup's record not readable: the address below */ }
  const set = env.OLLAMA_HOST ? 'OLLAMA_HOST' as const : env.OLLAMA_BASE_URL ? 'OLLAMA_BASE_URL' as const : null;
  const raw = set ? String(env[set]) : OLLAMA_DEFAULT_ADDRESS;
  return { origin: raw.replace(/\/+$/, ''), from: set ?? 'the default' };
}

/**
 * R5 lead (H131's finding): the Ollama address the check asks and the card names: the one the local chat asks when the chat
 * is set to the local model, else OLLAMA_HOST (or OLLAMA_BASE_URL), else Ollama's default.
 */
export const ollamaAddress = (env: Env = process.env): string => ollamaRoute(env).origin;

/** The step that starts or installs Ollama here: its program when it is on the PATH, else this platform's way to install it. */
export function ollamaStartStep(o: { cli: boolean; platform: NodeJS.Platform }): string {
  if (o.cli) return 'ollama serve, then ollama pull <model>';
  switch (o.platform) {
    case 'darwin': return 'brew install ollama; brew services start ollama; ollama pull <model>';
    case 'linux': return 'install Ollama: ollama.com/download/linux; then ollama pull <model>';
    case 'win32': return 'install Ollama: ollama.com/download/windows; then ollama pull <model>';
    default: return 'install Ollama: ollama.com/download; then ollama pull <model>';
  }
}

/** The setting that names the address, as a step: the chat setup's, or the variable it was read from. */
export function ollamaAddressStep(from: OllamaFrom | undefined): string {
  if (from === 'the chat setup') return 'set the address: /setup chat (or timmy init --chat local)';
  if (from === 'OLLAMA_BASE_URL') return 'set OLLAMA_BASE_URL to the address Ollama listens on';
  return 'set OLLAMA_HOST to the address Ollama listens on, such as 127.0.0.1:11434';
}

/** Where the address came from, in words for a row's detail ("the chat setup's address"). */
export const ollamaFromWords = (from: OllamaFrom | undefined): string => (
  from === 'the chat setup' ? 'the address the chat setup recorded' : from === 'OLLAMA_HOST' || from === 'OLLAMA_BASE_URL' ? `the address in ${from}` : 'Ollama\'s default address'
);
