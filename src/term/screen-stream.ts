/**
 * The stream a full-screen frame is drawn through (C-11, CHECKPOINTS row 27). Ink clears the whole
 * terminal with ED 2, ED 3 and home on a frame that fills or overflows the screen and on its last
 * frame at exit. ED 3 ("erase saved lines") erases the scrollback, and some terminals (VTE) drop the
 * main screen's scrollback even when it is sent from the alternate screen. This stream is the
 * terminal for everything else (size, TTY, resize events, callbacks) and drops ED 3 only.
 */
export const ERASE_SAVED_LINES = '\x1b[3J';

/** `transform` rewrites each text chunk on its way out (the monitor's law-to-palette map, row 28). */
export function screenStream(out: NodeJS.WriteStream, transform: (text: string) => string = (text) => text): NodeJS.WriteStream {
  const write = (chunk: unknown, ...rest: unknown[]): boolean => {
    const data = typeof chunk === 'string' ? transform(chunk.includes(ERASE_SAVED_LINES) ? chunk.split(ERASE_SAVED_LINES).join('') : chunk) : chunk;
    return (out.write as (...args: unknown[]) => boolean)(data, ...rest);
  };
  // A Proxy, not a copy: listeners, size and stream state stay the terminal's own.
  return new Proxy(out, { get: (target, key) => (key === 'write' ? write : Reflect.get(target, key, target)) });
}
