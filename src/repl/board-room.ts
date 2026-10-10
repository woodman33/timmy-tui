/**
 * Round R4 (H48): the board's Control Room section, drawn from the room's picture (src/room/index.ts): what runs now,
 * then the recent runs grouped by who owns them, the project's costs as recorded, and the /tools ladder as a panel of
 * tools and connections. The snapshot (/board) and the live board (/board live) draw the same section; on the live board
 * each run this REPL can stop has a Stop button.
 *
 * A Stop button is data only (src/repl/board-kit.ts act): `data-act="room-stop"` with `data-job` or `data-flow`. The
 * live page sends it as {"action":"stop","job":…} or {"action":"stop","flow":…}, which the live board checks against
 * its state (src/repl/board-live.ts checkAction) and runs as the typed /stop through the Workspace, with the same token,
 * Host and Origin rules as every other action. This section adds no way to stop anything.
 *
 * Every string is escaped; a file is a relative link on the snapshot and text on the live board (it serves no files);
 * no style attribute is written (the live page's Content-Security-Policy allows none). Colour never stands alone: each
 * state, cost and rung is a word, and green is kept for the buttons and the copy commands (never for an outcome).
 */
import { HOMEBREW, TYPE } from '../theme/tokens.js';
import type { CapabilityRow } from '../capabilities/index.js';
import { costParts, RUNG_WORDS, toolGroups, type RoomCosts, type RoomRun, type RoomStep, type RoomView, type Tone } from '../room/index.js';
import { costWords } from '../room/text.js';
import { esc, stamp, type Kit } from './board-kit.js';

const cls = (s: string): string => s.replace(/[^a-z0-9]+/gi, '').toLowerCase();
const STATE_CLASS: Readonly<Record<Tone, string>> = { running: 'rs-running', ok: 'rs-ok', failed: 'rs-failed', stopped: 'rs-stopped', attention: 'rs-attention', neutral: 'rs-neutral' };

/**
 * A step of a handoff chain, as a numbered row: its name and its state in words (and "ended here" or "running now" on the
 * step that holds the flow), then who did it, then its job and receipt where the record names them.
 */
function stepHtml(s: RoomStep): string {
  const meta = [s.job ? `job ${s.job}` : '', s.receipt ? `receipt ${s.receipt}` : '', s.detail ?? ''].filter(Boolean).join(' · ');
  return `<li class="ho ho-${cls(String(s.state))}${s.here ? ' ho-here' : ''}"${s.here ? ' aria-current="step"' : ''}>`
    + `<div class="ho-top"><span class="ho-name">${esc(s.name)}</span> <span class="ho-state">${esc(String(s.state))}</span>${s.here ? ` <span class="ho-here-words">${esc(s.here)}</span>` : ''}</div>`
    + `<div class="ho-owner">${esc(s.owner)}</div>${meta ? `<div class="ho-meta">${esc(meta)}</div>` : ''}</li>`;
}

/** The costs line as the board draws it: the same words as costsLine, only the unknown part in the attention colour. */
export function costsHtml(c: RoomCosts): string {
  const p = costParts(c);
  return `<strong class="cost-known">${esc(p.known)}</strong> · <span class="${c.unknown ? 'cost-unknown' : 'cost-none'}">${esc(p.unknown)}</span> · <span class="cost-free">${esc(p.free)}</span>; <span class="cost-none">${esc(p.rest)}</span>`;
}

/** The handoff chain as an ordered list (it needs no script). */
export function handoffHtml(r: RoomRun): string {
  if (!r.handoff?.length) return '';
  const what = r.kind === 'flow' ? `the handoffs of flow ${r.id}` : `the job and result of ${r.id}`;
  return `<ol class="handoff" aria-label="${esc(what)}">${r.handoff.map(stepHtml).join('')}</ol>`;
}

/** One run as a card: who, its state, its route, its time and progress, its cost, its handoffs, its outputs, its Stop. */
export function runCard(r: RoomRun, k: Kit): string {
  const route = [r.harness ?? '', r.model ? `model ${r.model}` : ''].filter(Boolean).join(' · ');
  const endpoint = r.endpoint ? `<span class="room-endpoint ep-${r.endpoint}">${esc(r.endpoint === 'local' ? 'local' : 'remote')}</span> ` : '';
  const paid = /^paid\b/.test(r.route) ? ' room-paid' : '';
  const when = [r.step ?? '', r.startedAt ? `started ${stamp(r.startedAt)}` : '', r.elapsed ?? ''].filter(Boolean).join(' · ');
  const costClass = `cost-${r.cost.kind}`;
  const facts = [
    `<dt>route</dt><dd>${route ? `${esc(route)} · ` : ''}${endpoint}<span class="room-route${paid}">${esc(r.route)}</span></dd>`,
    when ? `<dt>${r.running ? 'running' : 'ran'}</dt><dd>${esc(when)}</dd>` : '',
    r.progress ? `<dt>${r.running ? 'progress' : 'last'}</dt><dd class="room-progress">${esc(r.progress)}</dd>` : '',
    `<dt>cost</dt><dd class="${costClass}">${esc(costWords(r))}</dd>`,
  ].join('');
  const outputs = r.outputs.map((o) => `<li><span class="art-role">${esc(o.role)}</span> ${k.fileLink(o.path, 'file')}</li>`).join('');
  const record = [
    r.record ? `record ${k.fileLink(r.record, 'file')}${r.recordNote ? ` <span class="tier">${esc(r.recordNote)}</span>` : ''}` : '',
    esc(r.receipt ? `receipt ${r.receipt}` : 'no receipt seals it yet'),
    r.receipts?.length ? esc(`its record names receipts ${r.receipts.join(', ')}`) : '',
  ].filter(Boolean).join(' · ');
  const details = `<details class="more" data-keep="${esc(`room:${r.kind}:${r.id}:outputs`)}"><summary>${esc(`outputs (${r.outputs.length}) and record`)}</summary>`
    + `<div class="more-body">${outputs ? `<ul class="room-outs">${outputs}</ul>` : `<p class="empty">${esc('Its record names no outputs.')}</p>`}<div class="meta">${record}</div></div></details>`;
  const stop = r.running && r.stop
    ? k.act('Stop', r.stop.kind === 'flow' ? { act: 'room-stop', flow: r.stop.id } : { act: 'room-stop', job: r.stop.id })
    : '';
  const commands = [
    ...(r.running && r.stop && !k.live ? [`/stop ${r.stop.id}`] : []),
    ...(r.running && !r.stop && r.hint?.startsWith('/') ? [r.hint] : []),
    `/room ${r.id}`,
  ];
  const hint = r.running && !r.stop ? `<p class="meta room-hint">${esc(r.hint && !r.hint.startsWith('/') ? r.hint : 'This REPL did not start it, so the board does not stop it.')}</p>` : '';
  return `<article class="card room-run ${STATE_CLASS[r.tone]}" data-room-kind="${esc(r.kind)}" data-room-id="${esc(r.id)}">`
    + `<div class="jobhead"><strong class="room-owner">${esc(r.owner)}</strong> <span class="room-state">${esc(r.state)}</span></div>`
    + `<div class="meta"><span class="kind">${esc(r.kind)}</span> ${esc(r.id)}${r.job && r.job !== r.id ? esc(` · job ${r.job}`) : ''}${r.partOf ? esc(` · ${r.partOf}`) : ''}</div>`
    + `<dl class="room-facts">${facts}</dl>${handoffHtml(r)}${details}${hint}`
    + `<div class="cmds">${stop}${commands.map((c) => k.cmd(c)).join('')}</div></article>`;
}

/** A tool row: its name, its rung in words, what the check found, when a run last used it, and the step that sets it up. */
function toolRow(r: CapabilityRow & { missing?: true }): string {
  return `<li class="tl${r.missing ? ' tl-missing' : ''}"><div class="tl-head"><span class="tl-name">${esc(r.name.trim())}</span> <span class="rung rung-${cls(r.rung)}">${esc(r.rung)}</span></div>`
    + `<div class="tl-detail">${esc(r.detail)}</div>${r.exercised ? `<div class="tl-used">${esc(`used ${r.exercised.slice(0, 10)} (a run's own sealed record)`)}</div>` : ''}`
    + `${r.setup ? `<div class="tl-step">do: <code>${esc(r.setup)}</code></div>` : ''}</li>`;
}

/** The /tools ladder as the panel: its groups, as the Control Room last checked them, or how to check them. */
export function toolsPanel(v: RoomView, k: Kit): string {
  const t = v.tools;
  if (!t) {
    return `<p class="empty">${esc('Not checked yet in this session: /room checks every tool the way /tools does (without contacting OpenRouter), and this panel then shows what it found.')}</p>${k.cmds(['/room', '/tools'])}`;
  }
  const groups = toolGroups(t.rows).map((g) => `<section class="card room-toolgroup"><h4>${esc(g.title)} <span class="count">${g.rows.length}</span></h4>`
    + `<ul class="room-toollist">${g.rows.map(toolRow).join('')}</ul>${g.note ? `<p class="meta">${esc(g.note)}</p>` : ''}</section>`).join('');
  const legend = (Object.keys(RUNG_WORDS) as Array<keyof typeof RUNG_WORDS>).map((r) => `${r}: ${RUNG_WORDS[r]}`).join(' · ');
  return `<p class="meta">${esc(`checked ${stamp(t.checkedAt)} by /room; ${legend}. "Used" comes only from a run's own sealed record; a rung is what the check found now.`)}</p>`
    + `${t.note ? `<p class="meta">${esc(t.note)}</p>` : ''}<div class="grid room-tools">${groups}</div>${k.cmds(['/room', '/tools'])}`;
}

/** The section: its table-of-contents entry and its HTML. */
export function roomSection(v: RoomView, k: Kit): { toc: string; html: string } {
  const running = v.running.length;
  const groups = v.groups.filter((g) => g.recent.length);
  const c = v.costs;
  const costs = `<div class="room-costs"><span class="room-label">costs, as recorded</span> <span class="room-costline">${costsHtml(c)}</span>`
    + `<p class="meta">${esc('From the runs\' receipts first, else their own records; one charge seen through two records is counted once. Unknown stays unknown, never 0, and no budget or remaining amount is shown.')}</p></div>`;
  return {
    toc: `<a href="#room">Control Room <b>${running ? `${running} running` : 'idle'}</b></a>`,
    html: [
      `<h2 id="room">Control Room <span class="count">${esc(running ? `${running} running` : 'nothing running')}</span></h2>`,
      `<section class="room"><p class="sub room-lead">${esc(`Who runs what in ${v.project}: each run's owner, route, state, handoffs, cost and outputs, from its own record and receipt.${k.live ? ' Stop acts as the typed /stop, only on a run this REPL started.' : ''}`)}</p>`,
      costs,
      `<h3 id="room-running">Running now <span class="count">${running}</span></h3>`,
      running ? `<div class="grid wide room-runs">${v.running.map((r) => runCard(r, k)).join('')}</div>` : `<p class="empty">${esc('Nothing runs in this project now.')}</p>`,
      `<h3 id="room-crew">Recent, by owner</h3>`,
      groups.length
        ? groups.map((g) => `<section class="room-group" data-room-group="${esc(g.kind)}"><h4>${esc(g.title)} <span class="count">${esc(g.more ? `${g.recent.length} newest of ${g.recent.length + g.more}` : String(g.recent.length))}</span></h4>`
          + `${g.note ? `<p class="meta">${esc(g.note)}</p>` : ''}<div class="grid wide">${g.recent.map((r) => runCard(r, k)).join('')}</div></section>`).join('')
        : `<p class="empty">${esc('No finished runs recorded in this project yet.')}</p>`,
      ...v.notes.map((n) => `<p class="more">${esc(n)}</p>`),
      `<h3 id="room-tools">Tools and connections</h3>`,
      toolsPanel(v, k),
      '</section>',
    ].join('\n'),
  };
}

export const ROOM_CSS = `
.room .room-lead { margin: 0 0 10px; }
.room-costs { background: ${HOMEBREW.surface}; border: 1px solid ${HOMEBREW.line}; border-left: 3px solid ${HOMEBREW.attention}; border-radius: 8px; padding: 10px 12px; margin: 0 0 6px; overflow-wrap: anywhere; }
.room-costs .room-label { text-transform: uppercase; letter-spacing: .06em; font-size: 11px; color: ${HOMEBREW.textSecondary}; margin-right: 8px; }
.room-costs .cost-known { font-weight: ${TYPE.weight.strong}; color: ${HOMEBREW.text}; }
.room-costs .cost-unknown { font-weight: ${TYPE.weight.strong}; color: ${HOMEBREW.attention}; }
.room-costs .cost-free, .room-costs .cost-none { color: ${HOMEBREW.textSecondary}; }
.room-costs .meta { margin: 4px 0 0; }
.room-group { margin: 0 0 14px; }
.room-group > h4 { margin: 14px 0 8px; font-size: 12px; }
.room .card.room-run { align-self: start; gap: 6px; border-left: 3px solid ${HOMEBREW.lineStrong}; }
.room .room-owner { overflow-wrap: anywhere; }
.room .room-state { text-transform: uppercase; letter-spacing: .05em; font-size: 11px; text-align: right; overflow-wrap: anywhere; color: ${HOMEBREW.text}; }
.room .rs-running { border-left-color: ${HOMEBREW.attention}; }
.room .rs-running .room-state, .room .rs-attention .room-state { color: ${HOMEBREW.attention}; }
.room .rs-failed { border-left-color: ${HOMEBREW.failure}; }
.room .rs-failed .room-state { color: ${HOMEBREW.failure}; }
.room .rs-stopped .room-state { color: ${HOMEBREW.textSecondary}; }
.room dl.room-facts { grid-template-columns: max-content minmax(0, 1fr); }
.room dl.room-facts dt { text-transform: uppercase; letter-spacing: .05em; font-size: 11px; }
.room .room-endpoint { display: inline-block; border: 1px solid ${HOMEBREW.lineStrong}; border-radius: 999px; padding: 0 6px; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; }
.room .ep-remote { color: ${HOMEBREW.ai}; border-color: ${HOMEBREW.ai}; }
.room .ep-local { color: ${HOMEBREW.textSecondary}; }
.room .room-paid { color: ${HOMEBREW.attention}; }
.room .room-progress { color: ${HOMEBREW.text}; white-space: pre-wrap; }
.room .cost-unknown { color: ${HOMEBREW.attention}; }
.room .cost-free, .room .cost-none { color: ${HOMEBREW.textSecondary}; }
.room .cost-known { color: ${HOMEBREW.text}; }
.room ol.handoff { list-style: none; margin: 2px 0 0; padding: 0; counter-reset: ho; display: flex; flex-direction: column; font-size: 11.5px; line-height: 1.4; }
.room ol.handoff .ho { position: relative; padding: 0 0 8px 28px; min-width: 0; overflow-wrap: anywhere; }
.room ol.handoff .ho::before { counter-increment: ho; content: counter(ho); position: absolute; left: 0; top: 0; width: 18px; height: 18px; border-radius: 50%; border: 1px solid ${HOMEBREW.lineStrong}; background: ${HOMEBREW.surface}; color: ${HOMEBREW.text}; font-size: 10px; line-height: 16px; text-align: center; box-sizing: border-box; }
.room ol.handoff .ho:not(:last-child)::after { content: ""; position: absolute; left: 9px; top: 19px; bottom: 1px; border-left: 1px solid ${HOMEBREW.line}; }
.room ol.handoff .ho:last-child { padding-bottom: 0; }
.room .ho-top { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 8px; }
.room .ho-name { text-transform: uppercase; letter-spacing: .05em; font-weight: ${TYPE.weight.strong}; }
.room .ho-state { text-transform: uppercase; letter-spacing: .05em; font-size: 10.5px; color: ${HOMEBREW.text}; }
.room .ho-owner { color: ${HOMEBREW.text}; }
.room .ho-meta { color: ${HOMEBREW.textSecondary}; }
.room .ho-running::before, .room .ho-stopped::before, .room .ho-interrupted::before { border-color: ${HOMEBREW.attention}; color: ${HOMEBREW.attention}; }
.room .ho-running .ho-state, .room .ho-stopped .ho-state, .room .ho-interrupted .ho-state { color: ${HOMEBREW.attention}; }
.room .ho-failed::before { border-color: ${HOMEBREW.failure}; color: ${HOMEBREW.failure}; }
.room .ho-failed .ho-state { color: ${HOMEBREW.failure}; }
.room .ho-notrun::before, .room .ho-waiting::before { border-style: dashed; color: ${HOMEBREW.textSecondary}; }
.room .ho-notrun .ho-state, .room .ho-waiting .ho-state, .room .ho-notrun .ho-name, .room .ho-waiting .ho-name { color: ${HOMEBREW.textSecondary}; }
.room .ho-here .ho-name { text-decoration: underline; text-underline-offset: 3px; }
.room .ho-here-words { font-size: 10.5px; color: ${HOMEBREW.text}; }
.room details.more { border: 1px solid ${HOMEBREW.line}; border-radius: 6px; padding: 0 10px; }
.room details.more > summary { cursor: pointer; padding: 6px 0; font-size: ${TYPE.size.small}px; color: ${HOMEBREW.textSecondary}; text-transform: uppercase; letter-spacing: .06em; }
.room details.more > summary:hover, .room details.more > summary:focus-visible { color: ${HOMEBREW.text}; outline: none; }
.room details.more > summary:focus-visible { box-shadow: 0 0 0 2px ${HOMEBREW.accent}; border-radius: 4px; }
.room details.more > .more-body { display: flex; flex-direction: column; gap: 6px; padding-bottom: 10px; min-width: 0; }
.room ul.room-outs { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; font-size: ${TYPE.size.small}px; }
.room ul.room-outs li { display: flex; flex-wrap: wrap; gap: 4px 8px; min-width: 0; overflow-wrap: anywhere; }
.room .art-role { text-transform: uppercase; letter-spacing: .05em; font-size: 11px; color: ${HOMEBREW.textSecondary}; min-width: 7.5em; }
.room .room-hint { margin: 0; }
.room .grid.room-tools { grid-template-columns: repeat(auto-fill, minmax(min(320px, 100%), 1fr)); }
.room .room-toolgroup h4 { margin: 0; }
.room ul.room-toollist { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; font-size: ${TYPE.size.small}px; }
.room .tl { border-top: 1px solid ${HOMEBREW.line}; padding-top: 6px; min-width: 0; }
.room .tl:first-child { border-top: 0; padding-top: 0; }
.room .tl-head { display: flex; justify-content: space-between; gap: 8px; }
.room .tl-name { font-weight: ${TYPE.weight.strong}; overflow-wrap: anywhere; }
.room .rung { text-transform: uppercase; letter-spacing: .05em; font-size: 11px; white-space: nowrap; color: ${HOMEBREW.text}; }
.room .rung-reachable { font-weight: ${TYPE.weight.strong}; }
.room .rung-needssetup { color: ${HOMEBREW.attention}; }
.room .rung-notbuilt { color: ${HOMEBREW.textSecondary}; }
.room .tl-detail, .room .tl-used { color: ${HOMEBREW.textSecondary}; overflow-wrap: anywhere; }
.room .tl-step { overflow-wrap: anywhere; }
.room .tl-step code { font: inherit; color: ${HOMEBREW.text}; }
.room .tl-missing .tl-name { color: ${HOMEBREW.textSecondary}; }
`;
