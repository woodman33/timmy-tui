/**
 * R11 (H167, step 3e; H168's pass 4a R22): the sign-in address to the clipboard through OSC 52, the terminal's own clipboard
 * escape (`ESC ] 52 ; c ; <base64> BEL`). Whether the terminal takes it is not observable from here: a terminal answers nothing
 * to it. What is known is said as known: Terminal.app (TERM_PROGRAM=Apple_Terminal) takes none; kitty and WezTerm take it by
 * default; iTerm2 only with its "Applications in terminal may access clipboard" setting on; tmux passes it on by its
 * set-clipboard option. The words on the screen say that, and the paste shows whether it took.
 */

/** What is known of this terminal's OSC 52: yes (takes it by default), no (never), unknown (a setting decides, or not known). */
export type Osc52 = 'yes' | 'no' | 'unknown';

/** The terminal's OSC 52 as its environment names it (TERM_PROGRAM, TERM); nothing is asked of the terminal. */
export function osc52Support(env: Record<string, string | undefined>): Osc52 {
  const prog = (env.TERM_PROGRAM ?? '').toLowerCase();
  const term = (env.TERM ?? '').toLowerCase();
  if (prog === 'apple_terminal') return 'no';
  if (prog === 'wezterm' || term.includes('kitty')) return 'yes';
  return 'unknown';
}

/** The escape that puts `text` on the terminal's clipboard where the terminal takes OSC 52 (the 'c' selection). */
export function osc52(text: string): string {
  return `\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`;
}

/** The screen's row under the address: how to copy it, as what is known of the terminal allows. */
export function copyWords(support: Osc52): string {
  switch (support) {
    case 'yes': return 'c copies it to the clipboard (OSC 52, which this terminal takes by default).';
    case 'no': return 'Terminal.app takes no clipboard escape (OSC 52): m gives the mouse back to the terminal to select it, or Open it in the browser.';
    default: return 'c sends it to the clipboard (OSC 52; the paste shows whether this terminal took it). m gives the mouse back to the terminal to select it.';
  }
}

/** The notice after c: what was sent, and what is and is not known of its arrival. */
export function copiedWords(support: Osc52, what: string): string {
  return support === 'yes'
    ? `${what} is on the clipboard (OSC 52, which this terminal takes by default).`
    : `${what} was sent to the clipboard through OSC 52: the paste shows whether this terminal took it.`;
}
