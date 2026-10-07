/**
 * Terminal state and exit paths (playbook §16.7): documented exit codes, and the terminal restored
 * on every way out (return, exit, SIGINT, SIGTERM, uncaught errors), exactly once.
 */
export const EXIT = {
  ok: 0,
  failure: 1,
  usage: 2,
  dataErr: 65,
  noInput: 66,
  noPerm: 77,
  config: 78,
  cancelled: 130,
  terminated: 143,
} as const;

export interface SessionIO {
  stdin: { isTTY?: boolean; isRaw?: boolean; setRawMode?(mode: boolean): unknown };
  stdout: { isTTY?: boolean; write(s: string): unknown };
  stderr?: { write(s: string): unknown };
}

type ProcessLike = Pick<NodeJS.Process, 'on' | 'off'>;

export class TerminalSession {
  private readonly wasRaw: boolean;
  private altScreen = false;
  private restored = false;
  private stopping = false;
  private exited = false;
  private readonly teardowns: Array<() => void> = [];

  constructor(private readonly io: SessionIO, private readonly opts: { exit?: (code: number) => void } = {}) {
    this.wasRaw = io.stdin.isTTY ? io.stdin.isRaw === true : false;
  }

  private tty(seq: string): boolean {
    if (!this.io.stdout.isTTY) return false;
    this.io.stdout.write(seq);
    return true;
  }

  hideCursor(): void {
    this.tty('\x1b[?25l');
  }

  showCursor(): void {
    this.tty('\x1b[?25h');
  }

  enterAltScreen(): void {
    if (this.tty('\x1b[?1049h')) this.altScreen = true;
  }

  enableBracketedPaste(): void {
    this.tty('\x1b[?2004h');
  }

  setRaw(on: boolean): void {
    if (this.io.stdin.isTTY && this.io.stdin.setRawMode) this.io.stdin.setRawMode(on);
  }

  /**
   * Run `fn` just before the terminal is restored (newest first; a throw does not stop the restore).
   * A full-screen app draws its last frame here, while its own screen is still up (C-11, row 27).
   */
  beforeRestore(fn: () => void): () => void {
    this.teardowns.push(fn);
    return () => {
      const at = this.teardowns.indexOf(fn);
      if (at >= 0) this.teardowns.splice(at, 1);
    };
  }

  /** Attributes, bracketed paste, cursor, main screen and raw mode back as they were. Idempotent. */
  restore(): void {
    if (this.restored) return;
    this.restored = true;
    for (const fn of this.teardowns.splice(0).reverse()) {
      try { fn(); } catch { /* the restore below still runs */ }
    }
    this.tty('\x1b[0m\x1b[?2004l\x1b[?25h' + (this.altScreen ? '\x1b[?1049l' : ''));
    if (this.io.stdin.isTTY && this.io.stdin.setRawMode) this.io.stdin.setRawMode(this.wasRaw);
  }

  exit(code: number): void {
    this.restore();
    if (this.exited) return;
    this.exited = true;
    (this.opts.exit ?? process.exit)(code);
  }

  /** Stop: a second call forces; otherwise drain (at most 5s) and exit with `code`. */
  async shutdown(code: number, drain?: () => Promise<unknown>): Promise<void> {
    if (this.stopping) return this.exit(code);
    this.stopping = true;
    if (drain) {
      this.io.stderr?.write('\nCleaning up (Ctrl+C again to force)\n');
      await new Promise<void>((resolve) => {
        const force = setTimeout(resolve, 5000);
        force.unref?.();
        drain().then(() => { clearTimeout(force); resolve(); }, () => { clearTimeout(force); resolve(); });
      });
    }
    this.exit(code);
  }

  /** Wire exit paths: exit restores; SIGINT 130; SIGTERM 143; uncaught errors print and exit 1. */
  install(proc: ProcessLike = process, hooks: { drain?: () => Promise<unknown> } = {}): () => void {
    const onExit = (): void => this.restore();
    const onSigint = (): void => void this.shutdown(EXIT.cancelled, hooks.drain);
    const onSigterm = (): void => void this.shutdown(EXIT.terminated, hooks.drain);
    const onError = (e: unknown): void => {
      this.restore();
      this.io.stderr?.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
      this.exit(EXIT.failure);
    };
    proc.on('exit', onExit);
    proc.on('SIGINT', onSigint);
    proc.on('SIGTERM', onSigterm);
    proc.on('uncaughtException', onError);
    proc.on('unhandledRejection', onError);
    return () => {
      proc.off('exit', onExit);
      proc.off('SIGINT', onSigint);
      proc.off('SIGTERM', onSigterm);
      proc.off('uncaughtException', onError);
      proc.off('unhandledRejection', onError);
    };
  }
}
