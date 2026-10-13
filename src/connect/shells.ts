/**
 * Round R4 (helper H90): how a command reaches a device's shell.
 *
 * POSIX (macOS, Linux): the remote command is always the two words `sh -s`, which every login shell (bash, zsh, fish,
 * tcsh, ksh, dash) passes to sh unchanged; the script itself comes on stdin, wrapped in a function that is called on its
 * last line, so a script cut off by a dropped connection runs nothing. A job's own script bytes ride inside it as printf
 * octal escapes (POSIX printf writes exactly those bytes, NUL included), so its sha256 on the device equals Timmy's.
 *
 * Windows: Microsoft's OpenSSH Server runs a command through its default shell (cmd.exe unless the operator set
 * PowerShell), so PowerShell goes as `powershell.exe -NoProfile -NonInteractive -EncodedCommand <base64 of UTF-16LE>`:
 * base64 holds only letters, digits, "+", "/" and "=", which both shells pass through untouched. cmd.exe takes at most
 * 8,191 characters on a command line, so a longer one is refused here, and a job's script bytes go on stdin instead.
 */

/** A string as one POSIX shell word: single-quoted, each ' written '\''. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * A string as a PowerShell single-quoted (verbatim) literal. PowerShell takes any of five characters as a single quote:
 * ' and the typographic ‘ ’ ‚ ‛ (U+2018, U+2019, U+201A, U+201B; its language specification's single-quote-character).
 * Any of them would end the literal, so each is doubled: two in a row are one quote of that kind in the value.
 */
export function psQuote(s: string): string {
  return `'${s.replace(/['‘’‚‛]/g, (q) => q + q)}'`;
}

/** Bytes as printf format text: every byte an octal escape (no %, no quote, no newline in it). */
export function octal(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += `\\${b.toString(8).padStart(3, '0')}`;
  return out;
}

/** Lines of POSIX sh that append `bytes` to the file named by the shell variable `$<variable>`, at most `per` bytes a line. */
export function printfChunks(bytes: Uint8Array, variable: string, per = 512): string[] {
  const lines: string[] = [];
  for (let at = 0; at < bytes.length; at += per) lines.push(`  printf '${octal(bytes.subarray(at, at + per))}' >> "$${variable}" || return 1`);
  return lines;
}

/** cmd.exe's longest command line. */
export const CMD_MAX = 8191;
const POWERSHELL = ['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand'] as const;

/** A PowerShell script as -EncodedCommand's value: base64 of its UTF-16LE bytes. */
export function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/** An -EncodedCommand value back to its script (a check, and the tests'). */
export function decodePowerShell(encoded: string): string {
  return Buffer.from(encoded, 'base64').toString('utf16le');
}

/**
 * The remote command's words for a PowerShell script on a Windows device, refused when the line would pass cmd.exe's
 * limit (ssh joins the words with spaces into the one line the server's shell gets).
 */
export function powershellWords(script: string): string[] {
  const words = [...POWERSHELL, encodePowerShell(script)];
  const line = words.join(' ');
  if (line.length > CMD_MAX) throw new Error(`this PowerShell command is ${line.length} characters encoded, past cmd.exe's ${CMD_MAX}: it was not sent`);
  return words;
}

/** The remote command's words for a POSIX script (the script goes on stdin). */
export const POSIX_WORDS: readonly string[] = ['sh', '-s'];

/** A POSIX script that runs only once all of it has arrived: its body in a function called on the last line. */
export function wholeOrNothing(name: string, body: readonly string[]): string {
  return [`${name}() {`, ...body, '}', `${name}`, ''].join('\n');
}
