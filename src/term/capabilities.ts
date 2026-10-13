/**
 * What the terminal can do, decided once from the environment and the three standard streams
 * (playbook §16.6–16.7). Pure: callers pass `process.env` and the stream states, tests pass a matrix.
 */
export type ColorLevel = 0 | 1 | 2 | 3; // none, 16 theme colors, 256, 24-bit

export interface StreamState {
  isTTY: boolean;
  columns?: number;
  rows?: number;
}

export interface CapabilityFlags {
  /** `--color` (true) or `--no-color` (false); wins over every variable. */
  color?: boolean;
  /** `--plain`: one full-sentence line per status change, words for glyphs, no redraws. */
  plain?: boolean;
  /** `--reduced-motion`: static status lines. */
  reducedMotion?: boolean;
}

export interface CapabilityInput {
  env: Record<string, string | undefined>;
  stdin: StreamState;
  stdout: StreamState;
  stderr: StreamState;
  flags?: CapabilityFlags;
}

export interface TerminalCapabilities {
  color: ColorLevel;
  /** May emit SGR at all on stdout: any color level, or bold/attributes on a real, non-dumb terminal. */
  ansi: boolean;
  unicode: boolean;
  columns: number;
  rows: number;
  /** Prose wraps at min(columns, 80). */
  proseWidth: number;
  /** May prompt, use raw mode and ask the terminal questions (OSC 11, OSC 4). */
  interactive: boolean;
  /** May animate indicators (they go to stderr). */
  animate: boolean;
  /** May move the cursor to redraw the live region on stdout. */
  cursor: boolean;
  ci: boolean;
  plain: boolean;
  reducedMotion: boolean;
  ssh: boolean;
  multiplexer: 'tmux' | 'zellij' | 'screen' | null;
}

type Env = CapabilityInput['env'];

const isSet = (v: string | undefined): v is string => v !== undefined && v !== '';
const truthy = (v: string | undefined): boolean => isSet(v) && v !== '0' && v.toLowerCase() !== 'false';

export const CI_VARS = ['CI', 'CONTINUOUS_INTEGRATION', 'GITHUB_ACTIONS', 'GITLAB_CI', 'JENKINS_URL'];
export const isCI = (env: Env): boolean => CI_VARS.some((k) => truthy(env[k]));

/** Terminals that render UTF-8 themselves. Trusted only when no locale variable is set at all. */
const UTF8_TERMINALS = /^(ghostty|iTerm\.app|WezTerm|Apple_Terminal|vscode|kitty|alacritty)$/i;
const UTF8_TERMS = /^(xterm-ghostty|xterm-kitty|wezterm|alacritty|foot)/;

function detectColor(env: Env, stdout: StreamState, flag: boolean | undefined): ColorLevel {
  if (flag === false) return 0;
  const term = env.TERM ?? '';
  const fromTerm = (): ColorLevel => {
    if (term === 'dumb') return 0;
    if (/truecolor|24bit/i.test(env.COLORTERM ?? '')) return 3;
    if (term.includes('256color')) return 2;
    return term ? 1 : 0;
  };
  if (flag === true) return Math.max(1, fromTerm()) as ColorLevel;
  if (env.FORCE_COLOR !== undefined) {
    switch (env.FORCE_COLOR.toLowerCase()) {
      case '':
      case '1':
      case 'true':
        return 1;
      case '2':
        return 2;
      case '3':
        return 3;
      default:
        return 0;
    }
  }
  if (isSet(env.NO_COLOR) || !stdout.isTTY) return 0;
  return fromTerm();
}

function detectUnicode(env: Env, multiplexer: TerminalCapabilities['multiplexer']): boolean {
  if (env.TIMMY_UNICODE === '1') return true;
  if (env.TIMMY_UNICODE === '0') return false;
  if (isSet(env.WT_SESSION)) return true;
  const locale = [env.LC_ALL, env.LC_CTYPE, env.LANG].find(isSet);
  if (locale !== undefined) return /utf-?8/i.test(locale);
  // No locale at all. A multiplexer re-encodes by its own locale (tmux prints `_`), so stay ASCII.
  if (multiplexer) return false;
  return UTF8_TERMINALS.test(env.TERM_PROGRAM ?? '') || UTF8_TERMS.test(env.TERM ?? '');
}

export function detectCapabilities(input: CapabilityInput): TerminalCapabilities {
  const { env, stdin, stdout, stderr, flags = {} } = input;
  const dumb = env.TERM === 'dumb';
  const ci = isCI(env);
  const plain = flags.plain === true || env.TIMMY_PLAIN === '1';
  const reducedMotion = flags.reducedMotion === true || env.TIMMY_REDUCED_MOTION === '1';
  const multiplexer = isSet(env.TMUX) ? 'tmux' : env.ZELLIJ !== undefined ? 'zellij' : isSet(env.STY) ? 'screen' : null;
  const columns = stdout.columns && stdout.columns > 0 ? stdout.columns : 80;
  const rows = stdout.rows && stdout.rows > 0 ? stdout.rows : 24;
  const color = detectColor(env, stdout, flags.color);
  return {
    color,
    ansi: color > 0 || (stdout.isTTY && !dumb && flags.color !== false),
    unicode: detectUnicode(env, multiplexer),
    columns,
    rows,
    proseWidth: Math.min(columns, 80),
    interactive: stdin.isTTY && stdout.isTTY && !ci && !dumb,
    animate: stderr.isTTY && !ci && !dumb && !plain && !reducedMotion,
    cursor: stdout.isTTY && !dumb && !plain,
    ci,
    plain,
    reducedMotion,
    ssh: isSet(env.SSH_CLIENT) || isSet(env.SSH_TTY),
    multiplexer,
  };
}

/**
 * r21 (ledger row 163): the REPL cut its lines at the width the terminal had when it started, so a window made wider
 * kept the old width. Node keeps a terminal stream's columns and rows current; this reads them at each use, and keeps
 * the start's size when the stream is not a terminal or reports no size (a pane that reports 0 columns).
 */
export function liveSize(out: { isTTY?: boolean; columns?: number; rows?: number }, start: { columns: number; rows: number }): { readonly columns: number; readonly rows: number } {
  return {
    get columns(): number { return out.isTTY && out.columns && out.columns > 0 ? out.columns : start.columns; },
    get rows(): number { return out.isTTY && out.rows && out.rows > 0 ? out.rows : start.rows; },
  };
}

/** The capabilities of this process. */
export function currentCapabilities(flags?: CapabilityFlags): TerminalCapabilities {
  return detectCapabilities({
    env: process.env,
    stdin: { isTTY: process.stdin.isTTY === true },
    stdout: { isTTY: process.stdout.isTTY === true, columns: process.stdout.columns, rows: process.stdout.rows },
    stderr: { isTTY: process.stderr.isTTY === true },
    flags,
  });
}
