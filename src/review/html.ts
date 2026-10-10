/**
 * Round R4 (H65): the board's "Results and review" section (snapshot and live board alike), next to the Control Room's
 * operation cards: one card per recent operation that changed files, each file with how it changed and by which run, its
 * sha256 before and after, how it is now against what the run left, its previous version (kept where, or not kept), its
 * record and the receipt that sealed it, a bounded line diff of a text file when a previous version is kept, and a restore
 * where one can be done exactly.
 *
 * On the snapshot a restore is the typed command, which copies itself. On the live board it is a Restore button whose
 * meaning is data (data-act="restore", data-file, data-from: src/repl/board-kit.ts act). The live page sends it as
 * {"action":"restore","file":…,"from":…}; the live board checks the token, Host and Origin as for every action, then
 * checkRestoreAction below takes only a file and kept version this board's review shows now, and the Workspace runs it as the
 * typed /restore, which checks everything again on the server (src/review/restore.ts) and says why when it refuses. This
 * section adds no other way to write anything.
 *
 * Every string is escaped (src/repl/board-kit.ts esc) after control characters are made visible; a file is a relative link
 * on the snapshot and text on the live board; no style attribute is written (the live page's Content-Security-Policy allows
 * none). Colour never stands alone: each state and check is a word, a diff line carries its − or +, and green is kept for
 * the buttons and the commands.
 */
import { HOMEBREW, TYPE } from '../theme/tokens.js';
import { esc, stamp, type Kit } from '../repl/board-kit.js';
import type { CardCheck } from '../ops/card.js';
import { moreWords, restoreCommand, visible, type ReviewChange, type ReviewOperation, type ReviewView } from './changes.js';
import { shaWords } from './text.js';

/** What the section draws: the review, or why it could not be read. */
export type BoardReview = ReviewView | { error: string };

const v = (s: string): string => esc(visible(s));
const cls = (s: string): string => s.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
const checkHtml = (c: CardCheck): string => `<span class="rv-check rv-check-${c.status}"><b>${esc(c.status)}</b> ${v(c.words)}</span>`;

function diffHtml(op: string, c: ReviewChange): string {
  if (!c.diff) return '';
  if (!c.diff.shown) return `<p class="rv-nodiff">${v(`no line diff: ${c.diff.why}`)}</p>`;
  const d = c.diff.change;
  const line = (mark: string, cl: string, text: string): string => `<div class="${cl}"><span class="rv-mark" aria-hidden="true">${mark}</span><span class="rv-line">${v(text)}</span></div>`;
  const hunks = d.hunks.map((h) => `<div class="rv-hunk"><div class="rv-at">${esc(`@ line ${h.before_line} (now line ${h.after_line})`)}</div>`
    + h.removed.map((l) => line('−', 'rv-del', l)).join('')
    + (h.removed_total > h.removed.length ? `<div class="rv-cut">${esc(`and ${h.removed_total - h.removed.length} more lines taken out`)}</div>` : '')
    + h.added.map((l) => line('+', 'rv-ins', l)).join('')
    + (h.added_total > h.added.length ? `<div class="rv-cut">${esc(`and ${h.added_total - h.added.length} more lines put in`)}</div>` : '')
    + '</div>').join('');
  const more = d.hunks_total > d.hunks.length ? `<div class="rv-cut">${esc(`and ${d.hunks_total - d.hunks.length} more places`)}</div>` : '';
  const summary = `line diff: +${d.added} −${d.removed} in ${d.hunks_total} place${d.hunks_total === 1 ? '' : 's'} (the kept version → ${c.how === 'deleted' ? 'deleted' : 'the file as the run left it'})`;
  return `<details class="rv-diff" data-keep="${esc(`review:${op}:${c.source}:${c.runId}:${c.path}`)}"><summary>${esc(summary)}</summary><div class="rv-hunks">${hunks}${more}</div></details>`;
}

function changeHtml(op: string, c: ReviewChange, k: Kit): string {
  const record = c.record ? `${k.fileLink(visible(c.record), 'rv-file')} ` : `<span class="rv-meta">${esc('its receipt is its record')}</span> `;
  const restore = c.restore.offered
    ? (k.live ? `<div class="cmds">${k.act('Restore', { act: 'restore', file: c.path, from: c.restore.from })}</div>` : k.cmds([visible(c.restore.command)]))
    : `<p class="rv-no">${v(`restore: not offered: ${c.restore.why}`)}</p>`;
  return `<li class="rv-item rv-how-${cls(c.how)}" data-review-file="${esc(c.path)}">`
    + `<div class="rv-head"><span class="rv-how">${esc(c.how)}</span> ${k.fileLink(visible(c.path), 'rv-path')}</div>`
    + `<div class="rv-by">${v(`by ${c.by}${c.note ? ` · ${c.note}` : ''}`)}</div>`
    + '<dl class="rv-facts">'
    + `<dt>sha256</dt><dd>${esc(shaWords(c, '→').replace(/^sha256 /, ''))}</dd>`
    + `<dt>now</dt><dd class="rv-now rv-now-${cls(c.now.state)}"><b>${esc(c.now.state)}</b> ${v(c.now.words)}</dd>`
    + `<dt>before</dt><dd class="rv-kept${c.kept && c.kept.state !== 'ok' ? ' rv-kept-bad' : ''}">${v(c.keptWords)}</dd>`
    + `<dt>record</dt><dd>${record}${checkHtml(c.check)}</dd>`
    + '</dl>'
    + diffHtml(op, c) + restore + '</li>';
}

function operationHtml(op: ReviewOperation, k: Kit): string {
  const when = [op.via ? `from ${op.via}` : '', op.started ? `started ${stamp(op.started)}` : '', `${op.changes.length + op.more} change${op.changes.length + op.more === 1 ? '' : 's'}`].filter(Boolean).join(' · ');
  return `<article class="card rv-op rv-tone-${op.tone}" data-review-op="${esc(op.id)}">`
    + `<div class="jobhead"><strong class="rv-id">${esc(`Operation ${op.id}`)}</strong> <span class="rv-state">${esc(op.state)}</span></div>`
    + `<p class="rv-request"><span class="rv-label">request</span> <code>${v(op.request)}</code></p>`
    + `<p class="rv-meta">${esc(when)}${op.record ? ` · record ${k.fileLink(op.record, 'rv-file')}` : ''}</p>`
    + (op.changes.length ? `<ul class="rv-list">${op.changes.map((c) => changeHtml(op.id, c, k)).join('')}</ul>` : `<p class="empty">${esc('It changed no file Timmy records.')}</p>`)
    + (op.more ? `<p class="rv-meta rv-more">${esc(moreWords(op))}</p>` : '')
    + (op.notes.length ? `<ul class="rv-notes">${op.notes.map((n) => `<li>${v(n)}</li>`).join('')}</ul>` : '')
    + `${k.cmds([`/review ${op.id}`, `/op ${op.id}`])}</article>`;
}

/** The section: its table-of-contents entry and its HTML. */
export function reviewSection(r: BoardReview, k: Kit): { toc: string; html: string } {
  const lead = `<p class="sub rv-lead">${esc(`What each recent operation changed in the project, from its runs' own records; each file checked now against what its run left. A kept previous version shows its line diff. ${k.live ? 'Restore' : '/restore'} writes it back only over the file exactly as its run left it, never while a flow runs here, keeps the version it replaces under .timmy/restore-history/, and seals an edit receipt.`)}</p>`;
  if ('error' in r) {
    return {
      toc: '<a href="#review">Review <b>unreadable</b></a>',
      html: `<h2 id="review">Results and review</h2><section class="review">${lead}<p class="more">${v(`The review could not be read: ${r.error}`)}</p></section>`,
    };
  }
  const n = r.operations.length;
  return {
    toc: `<a href="#review">Review <b>${n}</b></a>`,
    html: [
      `<h2 id="review">Results and review <span class="count">${esc(n ? `${n} operation${n === 1 ? '' : 's'}` : 'nothing changed')}</span></h2>`,
      `<section class="review">${lead}`,
      n ? `<div class="grid wide rv-ops">${r.operations.map((op) => operationHtml(op, k)).join('')}</div>`
        : `<p class="empty">${esc(`None of the ${r.looked} newest operations changed a file Timmy records.`)}</p>`,
      r.quiet && n ? `<p class="more">${esc(`${r.quiet} other recent operation${r.quiet === 1 ? '' : 's'} changed no file Timmy records.`)}</p>` : '',
      `${k.cmds(['/review', '/ops'])}</section>`,
    ].join('\n'),
  };
}

/**
 * The pairs a live board's Restore may send: each change the review shows with a kept previous version, offered now or not.
 * A Restore drawn a moment before its file changed still reaches the typed /restore, which checks everything again and says
 * exactly why it refuses ("changed since the run …"), rather than the board answering that it offers nothing.
 */
export function restorePairs(r: BoardReview | undefined): Array<{ file: string; from: string }> {
  if (!r || 'error' in r) return [];
  return r.operations.flatMap((op) => op.changes.flatMap((c) => (c.kept && (c.how === 'changed' || c.how === 'deleted') ? [{ file: c.path, from: c.kept.path }] : [])));
}

export type RestoreChecked = { ok: true; command: { name: 'restore'; args: string; line: string } } | { ok: false; status: number; error: string };

/**
 * The live board's restore action: exactly {"action":"restore","file","from"}, a pair the board's review shows now (restorePairs);
 * the typed command it stands for, which checks everything again on the server.
 */
export function checkRestoreAction(body: Record<string, unknown>, pairs: ReadonlyArray<{ file: string; from: string }>): RestoreChecked {
  const bad = (status: number, error: string): RestoreChecked => ({ ok: false, status, error });
  const keys = Object.keys(body).sort().join(',');
  const textOk = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= 1024;
  if (keys !== 'action,file,from' || !textOk(body.file) || !textOk(body.from)) return bad(400, 'A restore action is {"action":"restore","file":"<file>","from":"<kept previous version>"}.');
  const { file, from } = body;
  if (!pairs.some((x) => x.file === file && x.from === from)) return bad(404, `This board shows no kept version ${visible(from).slice(0, 200)} of ${visible(file).slice(0, 200)} now: /review lists what can be restored.`);
  const line = restoreCommand(file, from);
  if (!line) return bad(422, `${visible(file).slice(0, 200)} cannot be written as /restore's arguments.`);
  return { ok: true, command: { name: 'restore', args: line.slice('/restore '.length), line } };
}

export const REVIEW_CSS = `
.review .rv-lead { margin: 0 0 10px; }
.review .card.rv-op { align-self: start; gap: 6px; border-left: 3px solid ${HOMEBREW.lineStrong}; }
.review .rv-op.rv-tone-running { border-left-color: ${HOMEBREW.attention}; }
.review .rv-op.rv-tone-failed { border-left-color: ${HOMEBREW.failure}; }
.review .rv-id { overflow-wrap: anywhere; }
.review .rv-state { text-transform: uppercase; letter-spacing: .05em; font-size: 11px; color: ${HOMEBREW.text}; }
.review .rv-request { margin: 0; overflow-wrap: anywhere; }
.review .rv-request code { font: inherit; color: ${HOMEBREW.text}; }
.review .rv-label { text-transform: uppercase; letter-spacing: .06em; font-size: 11px; color: ${HOMEBREW.textSecondary}; margin-right: 6px; }
.review .rv-meta, .review .rv-by, .review .rv-no, .review .rv-nodiff { margin: 0; color: ${HOMEBREW.textSecondary}; font-size: ${TYPE.size.small}px; overflow-wrap: anywhere; }
.review ul.rv-list, .review ul.rv-notes { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; font-size: ${TYPE.size.small}px; }
.review ul.rv-notes li { color: ${HOMEBREW.textSecondary}; overflow-wrap: anywhere; }
.review .rv-item { border-top: 1px solid ${HOMEBREW.line}; padding-top: 8px; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.review .rv-item:first-child { border-top: 0; padding-top: 0; }
.review .rv-head { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: baseline; }
.review .rv-how { text-transform: uppercase; letter-spacing: .05em; font-size: 11px; color: ${HOMEBREW.text}; border: 1px solid ${HOMEBREW.lineStrong}; border-radius: 999px; padding: 0 6px; }
.review .rv-path { font-weight: ${TYPE.weight.strong}; overflow-wrap: anywhere; color: ${HOMEBREW.text}; }
.review a.rv-path, .review a.rv-file { color: ${HOMEBREW.link}; }
.review dl.rv-facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 2px 10px; margin: 0; }
.review dl.rv-facts dt { text-transform: uppercase; letter-spacing: .05em; font-size: 11px; color: ${HOMEBREW.textSecondary}; }
.review dl.rv-facts dd { margin: 0; overflow-wrap: anywhere; color: ${HOMEBREW.text}; }
.review .rv-now b, .review .rv-check b { text-transform: uppercase; letter-spacing: .05em; font-size: 10.5px; margin-right: 4px; color: ${HOMEBREW.text}; }
.review .rv-now-changed-since b, .review .rv-now-back b, .review .rv-now-not-comparable b, .review .rv-check-stale b, .review .rv-check-unverified b { color: ${HOMEBREW.attention}; }
.review .rv-now-gone b, .review .rv-check-missing b { color: ${HOMEBREW.failure}; }
.review .rv-check { color: ${HOMEBREW.textSecondary}; }
.review .rv-kept-bad { color: ${HOMEBREW.attention}; }
.review details.rv-diff { border: 1px solid ${HOMEBREW.line}; border-radius: 6px; padding: 0 8px; }
.review details.rv-diff > summary { cursor: pointer; padding: 5px 0; color: ${HOMEBREW.textSecondary}; }
.review details.rv-diff > summary:focus-visible { outline: 2px solid ${HOMEBREW.accent}; outline-offset: 1px; border-radius: 4px; }
.review .rv-hunks { display: flex; flex-direction: column; gap: 6px; padding-bottom: 8px; overflow-x: auto; }
.review .rv-hunk { display: flex; flex-direction: column; font-family: ${TYPE.stack}; }
.review .rv-at, .review .rv-cut { color: ${HOMEBREW.textSecondary}; }
.review .rv-del, .review .rv-ins { display: flex; gap: 8px; white-space: pre; padding: 0 4px; color: ${HOMEBREW.text}; }
.review .rv-del { background: ${HOMEBREW.ground}; }
.review .rv-ins { background: ${HOMEBREW.raised}; }
.review .rv-mark { color: ${HOMEBREW.textSecondary}; user-select: none; }
`;
