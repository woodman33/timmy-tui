/**
 * R4 lead (2026-10-12): a shell word that holds `text` as it is: single-quoted, each ' inside written '\''. Anything a shell
 * reads from it is that text, never shell code: $(...), `...`, $VAR, \ and " stay characters.
 *
 * Its own module (no imports) so src/agent/lanes.ts can use it without an import cycle through src/utils/dispatch.ts.
 */
export const shellWord = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`;
