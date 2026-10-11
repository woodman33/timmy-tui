/**
 * Round R4 (H22): the small HTML kit the board's new cards share (src/repl/board-cards.ts, board-nodes.ts):
 * escaping, a file as a relative link (or as text on the live board, which serves no files), a command that
 * copies itself, and a live action button whose meaning is in escaped data-* attributes. It draws exactly
 * what src/repl/board.ts draws for the same things, so the page's scripts treat both alike. It imports
 * nothing from board.ts, so board.ts can import the new cards without an import cycle.
 */

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Text as HTML text or an attribute value: every markup character escaped. */
export const esc = (s: unknown): string => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

export interface Kit {
  /** the live board (127.0.0.1, with buttons) rather than the read-only snapshot */
  live: boolean;
  /** a project file as a link relative to the board's folder (snapshot) or as text (live) */
  fileLink(rel: string, cls?: string): string;
  /** a command that copies itself when clicked */
  cmd(c: string): string;
  cmds(list: string[]): string;
  /** a live action button (nothing on the snapshot): what it does is data, never command text */
  act(label: string, data: Record<string, string>): string;
  empty(what: string): string;
}

/** `base` leads from the board's folder back to the project's (made of ../ only; anything else is dropped). */
export function kit(o: { live: boolean; base: string }): Kit {
  const base = /^(?:\.\.\/)*$/.test(o.base) ? o.base : '';
  const href = (rel: string): string => esc(base + rel.split('/').map(encodeURIComponent).join('/'));
  const cmd = (c: string): string => `<button type="button" class="cmd" data-cmd="${esc(c)}" title="Copy this command"><code>${esc(c)}</code></button>`;
  return {
    live: o.live,
    fileLink: (rel, cls = 'name') => (o.live ? `<span class="${cls}">${esc(rel)}</span>` : `<a class="${cls}" href="${href(rel)}">${esc(rel)}</a>`),
    cmd,
    cmds: (list) => (list.length ? `<div class="cmds">${list.map(cmd).join('')}</div>` : ''),
    act: (label, data) => (o.live
      ? `<button type="button" class="act" ${Object.entries(data).map(([k, v]) => `data-${k}="${esc(v)}"`).join(' ')}>${esc(label)}</button>`
      : ''),
    empty: (what) => `<p class="empty">${esc(what)}</p>`,
  };
}

/** An ISO time as "YYYY-MM-DD HH:MM UTC"; anything else as it is (the board's own format). */
export const stamp = (when: string | number | Date | undefined): string => {
  if (when === undefined) return 'at an unknown time';
  const d = when instanceof Date ? when : new Date(when);
  return Number.isNaN(d.getTime()) ? String(when) : `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
};
