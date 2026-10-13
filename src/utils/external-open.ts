/**
 * R4 lead (2026-10-12, the dispatch audit): text that is not shell code (a file's path, a receipt's path, a page's address, a
 * hash) reaches macOS's `open` as a program argument and `pbcopy` as its input, never inside a shell string. Before, the
 * monitor's panels ran `open "${path}"` and `echo "${path}" | pbcopy` through a shell, so a file named with $(...) or `...`
 * in it ran that when it was opened or copied.
 *
 * Both are quiet no-ops where the program is missing (Linux, a stripped Mac), as the shell forms were.
 */
import { execFile, spawn } from 'node:child_process';

/** `open <target>`, or `open -t <target>` (the default text editor). */
export function openExternal(target: string, o: { textEditor?: boolean } = {}): void {
  try {
    const child = execFile('open', o.textEditor ? ['-t', target] : [target], () => { /* a missing open, a refused file: quiet, as before */ });
    child.on('error', () => { /* quiet */ });
  } catch { /* quiet */ }
}

/** `text` on the clipboard, exactly (no added newline), through pbcopy's input. */
export function copyToClipboard(text: string): void {
  try {
    const child = spawn('pbcopy', [], { stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', () => { /* no pbcopy here: quiet, as before */ });
    child.stdin?.on('error', () => { /* it ended before reading: quiet */ });
    child.stdin?.end(text);
  } catch { /* quiet */ }
}
