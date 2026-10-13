/**
 * Round R4 (H60): the Control Room's "Waiting on you" part on the board (snapshot and live), drawn from the decisions
 * (src/room/decisions.ts): what is waiting on a person in the project, what blocks a request first, each item with what is
 * needed, why (its record or check), the keys or setup steps, and the exact commands, which copy themselves. Nothing on it
 * acts: there is no button here (a NEEDS YOU box is answered in the REPL, a command is typed there), and each item says so.
 * Every string is escaped; a record is a relative link on the snapshot and text on the live board; no style attribute is
 * written (the live page's policy allows none); colours are the Homebrew tokens (attention for what blocks).
 */
import { HOMEBREW, TYPE } from '../theme/tokens.js';
import { NOTHING_DONE, type Decision, type DecisionsView } from '../room/decisions.js';
import { KIND_WORDS, NOTHING } from '../room/decisions-text.js';
import { esc, type Kit } from './board-kit.js';

/** One item: its title and kind, what is needed, why, its record, the keys or steps, the commands, the closing line. */
export function decisionHtml(d: Decision, k: Kit): string {
  const facts = [
    `<dt>needed</dt><dd>${esc(d.needed)}</dd>`,
    `<dt>why</dt><dd class="dec-why">${esc(d.why)}</dd>`,
    d.record ? `<dt>record</dt><dd>${k.fileLink(d.record, 'file')}${d.receipt ? esc(` · receipt ${d.receipt}`) : ''}</dd>` : '',
    d.keys?.length ? `<dt>keys</dt><dd>${d.keys.map((x) => `<kbd>${esc(x)}</kbd>`).join(' ')}</dd>` : '',
    ...(d.steps ?? []).map((s) => `<dt>step</dt><dd><code class="dec-step">${esc(s)}</code></dd>`),
  ].join('');
  return `<li class="dec dec-${esc(d.kind)}${d.blocks ? ' dec-blocks' : ''}" data-decision="${esc(d.key)}">`
    + `<div class="dec-head"><strong class="dec-title">${esc(d.title)}</strong> <span class="dec-kind">${esc(d.kindWords ?? KIND_WORDS[d.kind])}</span></div>`
    + `<dl class="dec-facts">${facts}</dl>${k.cmds(d.commands)}<p class="dec-nothing">${esc(NOTHING_DONE)}</p></li>`;
}

/** The part: its heading, the items, how many more, the other setup rows (folded), the tools check and the notes. */
export function decisionsHtml(v: DecisionsView, k: Kit): string {
  const lead = v.total
    ? 'What waits on a person in this project, what blocks a request first; each from the record or check it names. Nothing here acts: each item gives the keys, step or command for you to do.'
    : `Nothing waits on you here: ${NOTHING}.`;
  const items = v.items.length ? `<ol class="decisions">${v.items.map((d) => decisionHtml(d, k)).join('')}</ol>` : '';
  const more = v.more ? `<p class="more">${esc(`and ${v.more} more ${v.more === 1 ? 'waits' : 'wait'}: /decisions lists them`)}</p>${k.cmds(['/decisions'])}` : '';
  const other = v.otherSetup
    ? `<details class="more" data-keep="room:decisions:other-setup"><summary>${esc(`${v.otherSetup} other ${v.otherSetup === 1 ? 'row' : 'rows'} of /tools ${v.otherSetup === 1 ? 'needs' : 'need'} setup`)}</summary>`
      + `<div class="more-body"><p class="meta">${esc('For a tool no run of this project used or tried. /tools lists every row with its step; the Control Room\'s tools panel below shows the creative, agent, MCP, vision and model rows.')}</p>${k.cmds(['/tools'])}</div></details>`
    : '';
  const tools = v.tools.note ? `<p class="meta">${esc(`Setup: ${v.tools.note}`)}</p>` : '';
  const notes = v.notes.map((n) => `<p class="nomodel">${esc(n)}</p>`).join('');
  return `<h3 id="room-decisions">Waiting on you <span class="count">${v.total}</span></h3><p class="meta">${esc(lead)}</p>${items}${more}${other}${tools}${notes}`;
}

export const DECISIONS_CSS = `
.room ol.decisions { list-style: none; margin: 0 0 10px; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.room .dec { background: ${HOMEBREW.surface}; border: 1px solid ${HOMEBREW.line}; border-left: 3px solid ${HOMEBREW.lineStrong}; border-radius: 8px; padding: 8px 12px; min-width: 0; overflow-wrap: anywhere; }
.room .dec-blocks { border-left-color: ${HOMEBREW.attention}; }
.room .dec-head { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: baseline; }
.room .dec-title { color: ${HOMEBREW.text}; }
.room .dec-kind { text-transform: uppercase; letter-spacing: .05em; font-size: 11px; color: ${HOMEBREW.textSecondary}; }
.room .dec-blocks .dec-kind { color: ${HOMEBREW.attention}; }
.room dl.dec-facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 2px 10px; margin: 6px 0; font-size: ${TYPE.size.small}px; }
.room dl.dec-facts dt { text-transform: uppercase; letter-spacing: .05em; font-size: 11px; color: ${HOMEBREW.textSecondary}; }
.room dl.dec-facts dd { margin: 0; color: ${HOMEBREW.text}; min-width: 0; }
.room dl.dec-facts dd.dec-why { color: ${HOMEBREW.textSecondary}; }
.room .dec-step { font: inherit; color: ${HOMEBREW.text}; }
.room .dec kbd { font: inherit; border: 1px solid ${HOMEBREW.lineStrong}; border-radius: 4px; padding: 0 4px; color: ${HOMEBREW.text}; }
.room .dec-nothing { margin: 4px 0 0; font-size: 11.5px; color: ${HOMEBREW.textSecondary}; }
`;
