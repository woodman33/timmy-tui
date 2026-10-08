/**
 * Escape sequences that terminals act on but do not draw (DESIGN.md §10 B8): OSC 133 marks each turn
 * so the terminal and multiplexer can jump between prompts; OSC 8 makes text a link.
 */
export const OSC133 = {
  promptStart: '\x1b]133;A\x07',
  promptEnd: '\x1b]133;B\x07',
  outputStart: '\x1b]133;C\x07',
  end: (code: number): string => `\x1b]133;D;${code}\x07`,
};

/** Prompt-start before the first kept row of the input block, prompt-end after the last. */
export function markPromptRows(rows: string[]): string[] {
  if (rows.length === 0) return rows;
  const out = [...rows];
  out[0] = OSC133.promptStart + out[0];
  out[out.length - 1] = out[out.length - 1] + OSC133.promptEnd;
  return out;
}

/** OSC 8 link on a terminal; elsewhere the URL in full (playbook §16.3). */
export const hyperlink = (text: string, url: string, terminal: boolean): string =>
  terminal ? `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\` : `${text} (${url})`;
